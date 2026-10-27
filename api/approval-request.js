module.exports = async function (req, res) {
  // 1. SANITIZE INPUTS: This is critical. Email templates often inject hidden newlines.
  // A hidden newline in the URL breaks the HTTP headers, causing the exact 401 error.
  const decision = (req.query.decision || '').trim().toLowerCase();
  const reqId = (req.query.reqId || '').trim(); 
  const user_email = (req.query.user_email || '').trim();

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    // 2. SANITIZE ENVIRONMENT VARIABLES: Strip accidental spaces or slashes
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    const cleanApiKey = (process.env.ivanti_api_key || '').trim();

    if (!cleanApiKey) {
      throw new Error("Missing Ivanti API Key in Vercel environment variables.");
    }

    // 3. CONSTRUCT PRECISE URL: Replace spaces with %20 but leave $ literal for OData
    const filterString = `ServiceReqNumber eq ${reqId}`.replace(/ /g, '%20');
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterString}`;

    // Explicitly adding the Accept header to perfectly mimic Postman
    const ivantiHeaders = {
      'Authorization': `rest_api_key ${cleanApiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json' 
    };

    // 4. SEARCH IVANTI
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: ivantiHeaders
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
      throw new Error(`Ticket 200 OK, but list is empty. Checked ID: [${reqId}]`);
    }

    const internalRecId = searchData.value[0].RecId;

    // 5. UPDATE TICKET STATUS
    const ivantiResponse = await fetch(`https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`, {
      method: 'PATCH',
      headers: ivantiHeaders,
      body: JSON.stringify({
        Status: ivantiStatus
      })
    });

    if (!ivantiResponse.ok) {
      const errorBody = await ivantiResponse.text();
      throw new Error(`Ivanti PATCH failed. Status: ${ivantiResponse.status} | Details: ${errorBody}`);
    }

    // 6. SEND INFOBIP NOTIFICATION
    if (user_email) {
      const emailFormData = new FormData();
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("to", user_email);
      emailFormData.append("templateId", templateId);

      await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
        method: 'POST',
        headers: {
          'Authorization': `App ${(process.env.infobip_api_key || '').trim()}`
        },
        body: emailFormData
      });
    }

    // 7. SUCCESS SCREEN
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
    return res.status(500).send('Failed to process the request. Check Vercel logs for exact error.');
  }
};
