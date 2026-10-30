module.exports = async function (req, res) {
  // 1. Pull ALL routing variables dynamically from the Infobip URL payload.
  const { decision, reqId, user_email, approver_email, cfo_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const cleanReqId = reqId.trim();

  // 2. THE STATELESS IDENTITY CHECK
  // Compare the person who clicked (approver_email) against the CFO on file for this specific ticket (cfo_email).
  const isCFO = approver_email && cfo_email && approver_email.toLowerCase() === cfo_email.toLowerCase();

  // 3. MULTI-TIER STATUS LOGIC
  let ivantiStatus;
  if (decision !== 'approved') {
    ivantiStatus = 'Approval Rejected';
  } else if (isCFO) {
    ivantiStatus = 'Approved'; // Final sign-off
  } else {
    ivantiStatus = 'Approval Pending'; // Manager approved, waiting on CFO
  }

  try {
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // --- EXACTLY MATCHING YOUR BASE CODE ---
    const filterQuery = encodeURIComponent(`ServiceReqNumber eq ${cleanReqId}`);
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterQuery}&$top=1`;

    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: { 'Authorization': process.env.ivanti_api_key }
    });

    const searchData = await searchResponse.json();

    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket not found! ID: ${cleanReqId}`);
    }

    const currentTicket = searchData.value[0];
    const internalRecId = currentTicket.RecId;
    const currentStatus = currentTicket.Status;

    // RACE CONDITION & SEQUENTIAL CHECK
    let finalIvantiStatus = ivantiStatus;
    if (currentStatus === 'Approved' || currentStatus === 'Approval Rejected') {
      finalIvantiStatus = currentStatus;
    }

    // PATCH TICKET
    if (currentStatus !== finalIvantiStatus) {
      const patchTicketUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`;
      const ivantiResponse = await fetch(patchTicketUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': process.env.ivanti_api_key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ Status: finalIvantiStatus })
      });

      if (!ivantiResponse.ok) {
        throw new Error(`Ivanti API PATCH failed: ${ivantiResponse.status}`);
      }
    }

    // --- SEND FINAL EMAIL MATCHING YOUR BASE CODE ---
    if (user_email && (finalIvantiStatus === 'Approved' || finalIvantiStatus === 'Approval Rejected') && currentStatus !== finalIvantiStatus) {
      const templateId = finalIvantiStatus === 'Approved' ? '205000000088607' : '205000000088608';
      const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      const emailFormData = new FormData();
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("to", user_email);
      emailFormData.append("templateId", templateId);

      await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
        method: 'POST',
        headers: {
          'Authorization': `App ${process.env.infobip_api_key}`
        },
        body: emailFormData
      });
    }

    // --- HTML SCREEN MATCHING YOUR BASE CODE ---
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
