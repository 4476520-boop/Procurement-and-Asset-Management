module.exports = async function (req, res) {
  const { decision, reqId, user_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    // 1. URL SANITIZATION: This guarantees we never get a "fetch failed" (https://https://) error
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 2. SAFE ODATA QUERY: URL-encode the spaces exactly like Postman (%20)
    const filterQuery = encodeURIComponent(`ServiceReqNumber eq ${reqId}`);
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterQuery}`;

    // 3. SEARCH IVANTI (Using the exact Auth structure that previously gave us the 200 OK)
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

    // 4. UPDATE THE TICKET STATUS
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
      const errorText = await ivantiResponse.text();
      throw new Error(`Ivanti PATCH failed. Status: ${ivantiResponse.status} | Details: ${errorText}`);
    }

    // 5. SEND NOTIFICATION EMAIL
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

    // 6. SUCCESS SCREEN
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
    // Appending error.message gives us much cleaner logs without burying the lead
    console.error("Webhook Update Error:", error.message || error);
    return res.status(500).send('Failed to process the request. Check Vercel logs.');
  }
};
