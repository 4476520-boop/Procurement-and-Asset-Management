module.exports = async function (req, res) {
  // 1. Cleaned URL catcher: No PII variables accepted
  const { decision, reqId, role, token } = req.query;

  if (!decision || !reqId || !role || !token) {
    return res.status(400).send('Missing required security parameters.');
  }

  // 2. TOKEN AUTHORIZATION CHECK
  const validManagerToken = process.env.manager_token;
  const validCfoToken = process.env.cfo_token;

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
    if (currentStatus === 'Approved' || currentStatus === 'Approval Rejected') {
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

    // 7. SEND FINAL NOTIFICATION EMAIL
    if (user_email && (finalIvantiStatus === 'Approved' || finalIvantiStatus === 'Approval Rejected') && currentStatus !== finalIvantiStatus) {
      const templateId = finalIvantiStatus === 'Approved' ? '205000000088607' : '205000000088608';
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

      await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
        method: 'POST',
        headers: { 'Authorization': `App ${process.env.infobip_api_key}` },
        body: emailFormData
      });
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
