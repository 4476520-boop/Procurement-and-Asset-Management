module.exports = async function (req, res) {
  // 1. Cleaned URL catcher: No PII variables accepted
  const { decision, reqId, role, token } = req.query;

  if (!decision || !reqId || !role || !token) {
    return res.status(400).send('Missing required security parameters.');
  }

  // 2. TOKEN AUTHORIZATION CHECK
  const validManagerToken = process.env.manager_token;
  const validCfoToken = process.env.cfo_token;

  // Blocks any unrecognised roles
  if (role !== 'manager' && role !== 'cfo') {
    return res.status(401).send('Unauthorized: Unrecognized role signature.');
  } // <-- This was the missing closing brace

  if (role === 'manager' && token !== validManagerToken) {
    return res.status(401).send('Unauthorized: Invalid security signature.');
  }
  if (role === 'cfo' && token !== validCfoToken) {
    return res.status(401).send('Unauthorized: Invalid security signature.');
  }

  const cleanReqId = reqId.trim();
  const finalDecision = decision.toLowerCase();
  const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const ivantiAuth = { 'Authorization': process.env.ivanti_api_key };

  try {
    // 3. FETCH THE TICKET FROM IVANTI FIRST
    const filterQuery = encodeURIComponent(`ServiceReqNumber eq ${cleanReqId}`);
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterQuery}&$top=1`;

    const searchResponse = await fetch(searchUrl, { method: 'GET', headers: ivantiAuth });
    const searchData = await searchResponse.json();

    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket not found! ID: ${cleanReqId}`);
    }

    const currentTicket = searchData.value[0];
    const internalRecId = currentTicket.RecId;
    const currentStatus = currentTicket.Status;

    // 4. EXTRACT PII DIRECTLY FROM THE DATABASE
    const user_email = currentTicket.Email; 
    const safeUserName = currentTicket.ProfileFullName || 'Valued Team Member';

    // 5. DETERMINE FINAL STATUS
    let ivantiStatus;
    if (finalDecision !== 'approved') {
      ivantiStatus = 'Approval Rejected';
    } else if (role === 'cfo') {
      ivantiStatus = 'Approved';
    } else if (role === 'manager') {
      ivantiStatus = 'Approval Pending'; 
    }

    let finalIvantiStatus = ivantiStatus;
    if (currentStatus === 'Approved' || currentStatus === 'Approval') {
      finalIvantiStatus = currentStatus; // Prevent race conditions
    }

    // 6. PATCH TICKET
    if (currentStatus !== finalIvantiStatus) {
      const patchTicketUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`;
      const ivantiResponse = await fetch(patchTicketUrl, {
        method: 'PATCH',
        headers: { ...ivantiAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Status: finalIvantiStatus })
      });

      if (!ivantiResponse.ok) {
        throw new Error(`Ivanti API PATCH failed: ${ivantiResponse.status}`);
      }
    }

    // 7. SEND FINAL NOTIFICATION EMAIL (WITH AUTOMATIC RESEND FALLBACK)
    if (user_email && (finalIvantiStatus === 'Approved' || finalIvantiStatus === 'Approval Rejected') && currentStatus !== finalIvantiStatus) {
      const isApproved = finalIvantiStatus === 'Approved';
      const templateId = isApproved ? '205000000088607' : '205000000088608';
      const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      const emailFormData = new FormData();
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("templateId", templateId);

      const recipientData = JSON.stringify({
        "to": user_email,
        "placeholders": {
          "full_name": safeUserName,
          "Req_ID": cleanReqId
        }
      });
      emailFormData.append("to", recipientData);

      try {
        // Attempt Primary Route (Infobip)
        const infobipResponse = await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
          method: 'POST',
          headers: { 'Authorization': `App ${process.env.infobip_api_key}` },
          body: emailFormData
        });

        // If Infobip hits a limit, it returns a 4xx error. This forces the code into the catch block.
        if (!infobipResponse.ok) {
          throw new Error(`Infobip API blocked the request: ${infobipResponse.status}`);
        }
      } catch (fallbackError) {
        console.log("Triggering Resend Fallback:", fallbackError.message);

        // Dynamically build the body text matching your template screenshots
        const bodyContent = isApproved
          ? `<p>Your procurement request ${cleanReqId} has been approved.</p><p>The asset will be issued shortly.</p><p>Thank you for your patience.</p>` 
          : `<p>Your procurement request: ${cleanReqId} has been rejected at this time.</p>`; 

        // Construct the full HTML template
        const fallbackHtml = `
          <div style="font-family: 'Times New Roman', serif; max-width: 600px; margin: 0 auto; color: #000;">
            <!-- Note: Host your header/footer images in Vercel's /public folder and paste the real URLs here -->
            <img src="https://www.procuri.tech/procuri-banner.jpg" alt="Procuri Solutions" style="width: 100%; display: block;" />
            <div style="padding: 20px; font-size: 16px; line-height: 1.5;">
              <p>Dear ${safeUserName},</p>
              ${bodyContent}
              <br>
              <p>Kind Regards<br>Asset Management</p>
            </div>
            <img src="https://www.procuri.tech/procuri-footer.jpg" alt="Procurement" style="width: 100%; display: block;" />
            <div style="padding: 15px; font-family: Arial, sans-serif; font-size: 16px;">
              <p>Want to change how you receive these emails? You can <a href="#" style="color: #0000EE; text-decoration: underline;">UNSUBSCRIBE</a> from this list.</p>
            </div>
          </div>
        `;

        // Dispatch via Resend API
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.resend_api_key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Procuri IT Support <itsupport@procuri.tech>',
            to: user_email,
            subject: isApproved ? 'Approved Asset Request' : 'Rejected Asset Request',
            html: fallbackHtml
          })
        });
      }
    }

    const htmlResponse = `
      <html>
        <head><title>Decision Logged</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f3f5f9;">
          <h2 style="color: #163a63;">Request ${finalIvantiStatus}</h2>
          <p>Your decision for request <b>${cleanReqId}</b> has been securely logged in the ITSM system.</p>
          <p>You may now close this window.</p>
        </body>
      </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlResponse);

  } catch (error) {
    console.error("Webhook Update Error:", error);
    return res.status(500).send('Failed to process the request. Check logs for details.');
  }
};
