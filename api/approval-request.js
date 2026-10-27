module.exports = async function (req, res) {
  const { decision, reqId, user_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    // 1. Native Node.js URL encoding - exactly how Postman formats spaces safely
    const params = new URLSearchParams();
    params.append('$filter', `ServiceReqNumber eq ${reqId}`);

    const searchUrl = `https://${process.env.ivanti_tenant}/api/odata/businessobject/ServiceReqs?${params.toString()}`;

    // 2. Search Ivanti (Rolling back to the exact auth structure that gave us the 200 OK)
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `rest_api_key ${process.env.ivanti_api_key}`,
        'Content-Type': 'application/json'
      }
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      throw new Error(`Ivanti API Rejected Search. Status: ${searchResponse.status} | Details: ${errorText}`);
    }

    const searchData = await searchResponse.json();

    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket 200 OK, but list is empty. Checked ID: ${reqId}`);
    }

    const internalRecId = searchData.value[0].RecId;

    // 3. Update the Ticket Status using the internal RecId
    const ivantiResponse = await fetch(`https://${process.env.ivanti_tenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`, {
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
      const errorText = await ivantiResponse.text();
      throw new Error(`Ivanti PATCH failed. Status: ${ivantiResponse.status} | Details: ${errorText}`);
    }

    // 4. Send Employee Email
    if (user_email) {
      const emailFormData = new FormData();
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("to", user_email);
      emailFormData.append("templateId", templateId);

      await fetch(`https://${process.env.infobip_base_url}/email/3/send`, {
        method: 'POST',
        headers: {
          'Authorization': `App ${process.env.infobip_api_key}`
        },
        body: emailFormData
      });
    }

    // 5. Success Screen
    const htmlResponse = `
      <html>
        <head><title>Decision Logged</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f3f5f9;">
          <h2 style="color: #163a63;">Request ${ivantiStatus}</h2>
          <p>Your decision for request <b>${reqId}</b> has been securely logged in the ITSM system.</p>
          <p>You may now close this window.</p>
        </body>
      </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlResponse);

  } catch (error) {
    console.error("Webhook Update Error:", error.message);
    return res.status(500).send('Failed to process the request. Check Vercel logs.');
  }
};
