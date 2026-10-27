module.exports = async function (req, res) {
  // 1. Extract parameters from the URL query
  const { decision, user_email, reqId, requester_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  // 2. Map the decision to the specific status text Ivanti expects
  const ivantiStatus = decision === 'approved' ? 'Approved' : 'Denied';
  
  // 3. Assign the correct Infobip template ID for the requester email
  const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';

  try {
    // 4. Fire the direct PATCH request to the Ivanti Neurons REST API
    const ivantiResponse = await fetch(`https://${process.env.ivanti_tenant}.ivanticloud.com/api/odata/businessobject/ServiceReqs('${reqId}')`, {
      method: 'PATCH',
      headers: {
        'Authorization': `rest_api_key ${process.env.ivanti_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        Status: ivantiStatus,
        ApprovalReason: `Decision logged by ${user_email || 'Manager'} via automated workflow.`
      })
    });

    if (!ivantiResponse.ok) {
      throw new Error(`Ivanti API failed with status: ${ivantiResponse.status}`);
    }

    // 5. Trigger the Requester Notification Email via Infobip (if an email was provided)
    if (requester_email) {
      const emailFormData = new FormData();
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("to", requester_email);
      emailFormData.append("templateId", templateId);

      await fetch(`https://${process.env.infobip_base_url}/email/3/send`, {
        method: 'POST',
        headers: {
          'Authorization': `App ${process.env.infobip_api_key}`
        },
        body: emailFormData
      });
    }

    // 6. Return a simple HTML success page back to the manager's browser
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
    console.error("Webhook Update Error:", error);
    return res.status(500).send('Failed to process the request. Please contact the IT administrator.');
  }
};
