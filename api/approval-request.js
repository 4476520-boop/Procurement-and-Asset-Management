module.exports = async function (req, res) {
  const { decision, reqId, user_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  // 1. AGGRESSIVE SANITIZATION: Strips absolutely everything except letters and numbers. 
  // This guarantees no invisible email characters can break the Ivanti search.
  const cleanReqId = reqId.replace(/[^a-zA-Z0-9]/g, '');

  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); 

    if (!cleanIvantiTenant || !cleanInfobipUrl) {
      throw new Error("Missing Ivanti Tenant or Infobip Base URL in environment variables.");
    }

    // 2. CONSTRUCT EXACT POSTMAN URL
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=ServiceReqNumber%20eq%20${cleanReqId}`;

    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `rest_api_key ${process.env.ivanti_api_key}`,
        'Content-Type': 'application/json'
      }
    });

    const searchData = await searchResponse.json();

    // 3. DIAGNOSTIC ERROR: If it fails now, it prints the EXACT URL so you can copy/paste it to Postman
    if (!searchResponse.ok || !searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket not found! Vercel strictly searched for: [${searchUrl}]. If this URL works in Postman, your Vercel API Key lacks Role permissions to view this ticket.`);
    }

    const internalRecId = searchData.value[0].RecId;

    // 4. Update the Status field using the internal RecId
    const ivantiResponse = await fetch(`https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`, {
      method: 'PATCH',
      headers: {
        'Authorization': `rest_api_key ${process.env.ivanti_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        Status: ivantiStatus
      })
    });

    if (!ivantiResponse.ok) {
      throw new Error(`Ivanti API PATCH failed with status: ${ivantiResponse.status}`);
    }

    // 5. Send outcome email
    if (user_email) {
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

    // 6. Success screen
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
    console.error("Webhook Update Error:", error.message);
    return res.status(500).send(`Failed to process: ${error.message}`);
  }
};
