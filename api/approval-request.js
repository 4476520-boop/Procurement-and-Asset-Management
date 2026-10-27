module.exports = async function (req, res) {
  const { decision, reqId, user_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  // 1. STRIP HIDDEN CHARACTERS: This prevents email template newlines from breaking the ID
  const cleanReqId = reqId.trim();

  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    // 2. Bulletproof the environment variables by stripping any accidental https:// prefixes
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '');
    const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); 

    if (!cleanIvantiTenant || !cleanInfobipUrl) {
      throw new Error("Missing Ivanti Tenant or Infobip Base URL in environment variables.");
    }

    // 3. EXACT POSTMAN FORMATTING: Use %20 instead of spaces so Node.js sends it perfectly
    const searchResponse = await fetch(`https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=ServiceReqNumber%20eq%20${cleanReqId}`, {
      method: 'GET',
      headers: {
        'Authorization': `rest_api_key ${process.env.ivanti_api_key}`,
        'Content-Type': 'application/json'
      }
    });

    const searchData = await searchResponse.json();

    if (!searchResponse.ok || !searchData.value || searchData.value.length === 0) {
      throw new Error(`Could not find ticket number ${cleanReqId} in Ivanti.`);
    }

    const internalRecId = searchData.value[0].RecId;

    // 4. Update ONLY the Status field in Ivanti using the internal RecId
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

    // 5. Send the outcome email back to the original requester
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

    // 6. Return success screen to the manager
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
    return res.status(500).send('Failed to process the request. Please check the logs.');
  }
};
