module.exports = async function (req, res) {
  const { decision, reqId, user_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '');
    const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 1. Search Ivanti for the Ticket (QUOTES REMOVED FROM reqId)
    const searchResponse = await fetch(`https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=ServiceReqNumber eq ${reqId}`, {
      method: 'GET',
      headers: {
        'Authorization': `${process.env.ivanti_api_key}`,
        'Content-Type': 'application/json'
      }
    });

    const rawSearchData = await searchResponse.text();
    let searchData;
    try {
      searchData = JSON.parse(rawSearchData);
    } catch (e) {
      throw new Error(`Ivanti returned non-JSON response. Status: ${searchResponse.status}. Body: ${rawSearchData}`);
    }

    if (!searchResponse.ok) {
      throw new Error(`Ivanti API Rejected the Search. Status: ${searchResponse.status} | Details: ${JSON.stringify(searchData)}`);
    }
    
    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket 200 OK, but list is empty. Ivanti returned: ${JSON.stringify(searchData)}`);
    }

    const internalRecId = searchData.value[0].RecId;

    // 2. Update the Ticket Status field
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
      const errorBody = await ivantiResponse.text();
      throw new Error(`Ivanti PATCH failed. Status: ${ivantiResponse.status} | Details: ${errorBody}`);
    }

    // 3. Send Employee Email
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

    // 4. Success Screen
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
    return res.status(500).send('Failed to process the request. Check Vercel logs for exact Ivanti error.');
  }
};
