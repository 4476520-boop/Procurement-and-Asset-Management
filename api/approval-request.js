module.exports = async function (req, res) {
  const { decision, reqId, user_email, approver_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const cleanReqId = reqId.trim();
  const knownCfoEmail = (process.env.cfo_email || 'cfo@procuri.tech').toLowerCase();
  const isCFO = approver_email && approver_email.toLowerCase() === knownCfoEmail;

  let intendedStatus;
  if (decision !== 'approved') {
    intendedStatus = 'Approval Rejected'; 
  } else if (isCFO) {
    intendedStatus = 'Approved'; 
  } else {
    intendedStatus = 'Pending CFO Approval'; 
  }

  try {
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // --- IVANTI SEARCH ---
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

    // --- RACE CONDITION CHECK ---
    let finalIvantiStatus = intendedStatus;
    if (currentStatus === 'Approved' || currentStatus === 'Approval Rejected') {
      finalIvantiStatus = currentStatus;
    }

    // --- PATCH TICKET ---
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
        const errorText = await ivantiResponse.text();
        throw new Error(`Ivanti API PATCH failed: ${ivantiResponse.status} | Details: ${errorText}`);
      }
    }

    // --- SEND FINAL EMAIL TO REQUESTER ---
    if (user_email && (finalIvantiStatus === 'Approved' || finalIvantiStatus === 'Approval Rejected') && currentStatus !== finalIvantiStatus) {
      const templateId = finalIvantiStatus === 'Approved' ? '205000000088607' : '205000000088608';
      const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      // CRITICAL FIX: Use URLSearchParams instead of FormData to prevent Vercel crashing
      const emailParams = new URLSearchParams();
      emailParams.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailParams.append("to", user_email);
      emailParams.append("templateId", templateId);

      await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
        method: 'POST',
        headers: { 
          'Authorization': `App ${process.env.infobip_api_key}`,
          'Content-Type': 'application/x-www-form-urlencoded' // Required for URLSearchParams
        },
        body: emailParams
      });
    }

    // --- RENDER SCREEN ---
    const htmlResponse = `
      <html>
        <head><title>Decision Logged</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f3f5f9;">
          <h2 style="color: #163a63;">Decision Logged</h2>
          <p>Your decision for request <b>${cleanReqId}</b> has been securely recorded.</p>
          <p>Current Ticket Status: <b>${finalIvantiStatus}</b></p>
          <p>You may now close this window.</p>
        </body>
      </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlResponse);

  } catch (error) {
    console.error("Webhook Update Error:", error);
    return res.status(500).send(`Failed to process the request: ${error.message}`);
  }
};
