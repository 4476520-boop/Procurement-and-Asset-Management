module.exports = async function (req, res) {
  // 1. Cleaned up URL parameters (cfo_email is gone)
  const { decision, reqId, user_email, user_name, approver_email } = req.query;

  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const cleanReqId = reqId.trim();
  const safeUserName = user_name || 'Valued Team Member'; 
  const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const ivantiAuth = { 'Authorization': process.env.ivanti_api_key };

  try {
    // 2. ZERO TRUST IDENTITY CHECK (Dynamic CFO Lookup)
    const cfoQueryUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/Employees?$filter=Title eq 'CFO'&$top=1`;
    const cfoResponse = await fetch(cfoQueryUrl, { method: 'GET', headers: ivantiAuth });
    const cfoData = await cfoResponse.json();

    let validCfoEmail = null;
    if (cfoData.value && cfoData.value.length > 0) {
      validCfoEmail = cfoData.value[0].PrimaryEmail;
    }

    // Compare the person clicking against the true CFO record in Ivanti
    const isCFO = approver_email && validCfoEmail && approver_email.toLowerCase() === validCfoEmail.toLowerCase();

    // 3. MULTI-TIER STATUS LOGIC
    let ivantiStatus;
    if (decision !== 'approved') {
      ivantiStatus = 'Approval Rejected';
    } else if (isCFO) {
      ivantiStatus = 'Approved';
    } else {
      ivantiStatus = 'Approval Pending'; 
    }

    // 4. FETCH CURRENT TICKET STATUS
    const filterQuery = encodeURIComponent(`ServiceReqNumber eq ${cleanReqId}`);
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterQuery}&$top=1`;

    const searchResponse = await fetch(searchUrl, { method: 'GET', headers: ivantiAuth });
    const searchData = await searchResponse.json();

    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket not found! ID: ${cleanReqId}`);
    }

    const currentTicket = searchData.value[0];
    const internalRecId = currentTicket.RecId;
    const currentStatus = currentTicket.Status;

    // RACE CONDITION CHECK
    let finalIvantiStatus = ivantiStatus;
    if (currentStatus === 'Approved' || currentStatus === 'Approval Rejected') {
      finalIvantiStatus = currentStatus;
    }

    // 5. PATCH TICKET
    if (currentStatus !== finalIvantiStatus) {
      const patchTicketUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs('${internalRecId}')`;
      const ivantiResponse = await fetch(patchTicketUrl, {
        method: 'PATCH',
        headers: { ...ivantiAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Status: finalIvantiStatus })
      });

      if (!ivantiResponse.ok) {
        throw new Error(`Ivanti API PATCH failed: ${ivantiResponse.status}`);
      }
    }

    // 6. SEND FINAL NOTIFICATION EMAIL
    if (user_email && (finalIvantiStatus === 'Approved' || finalIvantiStatus === 'Approval Rejected') && currentStatus !== finalIvantiStatus) {
      const templateId = finalIvantiStatus === 'Approved' ? '205000000088607' : '205000000088608';
      const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      const emailFormData = new FormData();
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("to", user_email);
      emailFormData.append("templateId", templateId);

      const placeholders = JSON.stringify({
        "full_name": safeUserName,
        "Req_ID": cleanReqId
      });
      emailFormData.append("placeholders", placeholders);

      await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
        method: 'POST',
        headers: { 'Authorization': `App ${process.env.infobip_api_key}` },
        body: emailFormData
      });
    }

    // 7. RENDER SUCCESS SCREEN
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
