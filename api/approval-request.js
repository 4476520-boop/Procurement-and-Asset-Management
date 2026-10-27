module.exports = async function (req, res) {
  const { decision, reqId, user_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const cleanReqId = reqId.trim();
  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Approval Rejected';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // 1. URL encoding exactly matching process-scan.js
    const filterQuery = encodeURIComponent(`ServiceReqNumber eq ${cleanReqId}`);
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterQuery}&$top=1`;

    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      // CRITICAL FIX: Pass the env variable purely, exactly like process-scan.js
      headers: { 'Authorization': process.env.ivanti_api_key }
    });

    const searchData = await searchResponse.json();

    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket not found! ID: ${cleanReqId}`);
    }

    const internalRecId = searchData.value[0].RecId;

    // 2. Patch ticket exactly matching process-scan.js
    const patchTicketUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`;
    const ivantiResponse = await fetch(patchTicketUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': process.env.ivanti_api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ Status: ivantiStatus })
    });

    if (!ivantiResponse.ok) {
      throw new Error(`Ivanti API PATCH failed: ${ivantiResponse.status}`);
    }

    // 3. Send final notification email
    if (user_email) {
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

    // 4. Render success screen
    const htmlResponse = `
      <html>
        <head><title>Decision Logged</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f3f5f9;">
          <h2 style="color: #163a63;">Request ${ivantiStatus}</h2>
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
