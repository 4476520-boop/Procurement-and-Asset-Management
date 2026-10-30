module.exports = async function (req, res) {
  // ==========================================
  // STEP 1: CATCH INCOMING DATA
  // ==========================================
  // We extract the parameters Infobip attached to the button URL.
  const { decision, reqId, user_email, approver_email } = req.query;

  // If the URL is missing the decision or the ticket ID, stop immediately.
  if (!decision || !reqId) {
    return res.status(400).send('Missing required approval parameters.');
  }

  const cleanReqId = reqId.trim();
  
  // ==========================================
  // STEP 2: IDENTIFY THE APPROVER
  // ==========================================
  // We define who the CFO is using our Vercel Environment Variables.
  const knownCfoEmail = (process.env.cfo_email || 'cfo@procuri.tech').toLowerCase();
  
  // We check if the person who clicked this specific button is the CFO.
  const isCFO = approver_email && approver_email.toLowerCase() === knownCfoEmail;

  // ==========================================
  // STEP 3: DETERMINE THE INTENDED STATUS
  // ==========================================
  let intendedStatus;
  if (decision !== 'approved') {
    // The Hard Veto: If ANYONE clicks deny, the ticket is dead.
    intendedStatus = 'Approval Rejected'; 
  } else if (isCFO) {
    // Final Sign-off: If the CFO approves, the asset is fully funded and approved.
    intendedStatus = 'Approved'; 
  } else {
    // Manager Sign-off: The manager approved, but we are still waiting on the CFO.
    intendedStatus = 'Pending CFO Approval'; 
  }

  try {
    const cleanIvantiTenant = (process.env.ivanti_tenant || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // ==========================================
    // STEP 4: FETCH CURRENT TICKET STATUS
    // ==========================================
    // We look up the ticket in Ivanti using OData syntax (no quotes needed for ServiceReqNumber)
    const filterQuery = encodeURIComponent(`ServiceReqNumber eq ${cleanReqId}`);
    const searchUrl = `https://${cleanIvantiTenant}/api/odata/businessobject/ServiceReqs?$filter=${filterQuery}&$top=1`;

    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: { 'Authorization': process.env.ivanti_api_key }
    });

    const searchData = await searchResponse.json();

    // If the ticket doesn't exist in the database, throw an error.
    if (!searchData.value || searchData.value.length === 0) {
      throw new Error(`Ticket not found! ID: ${cleanReqId}`);
    }

    const currentTicket = searchData.value[0];
    const internalRecId = currentTicket.RecId; // Ivanti's internal hidden ID for patching
    const currentStatus = currentTicket.Status;

    // ==========================================
    // STEP 5: THE RACE CONDITION SAFEGUARD
    // ==========================================
    // Because both emails went out simultaneously, we must protect the ticket.
    // If the ticket is ALREADY fully approved (CFO was faster) or rejected (someone vetoed),
    // we freeze the status and ignore the delayed click.
    let finalIvantiStatus = intendedStatus;
    if (currentStatus === 'Approved' || currentStatus === 'Approval Rejected') {
      finalIvantiStatus = currentStatus;
    }

    // ==========================================
    // STEP 6: PATCH TICKET IN IVANTI
    // ==========================================
    // We only send a PATCH request to Ivanti if the status actually needs to change.
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

    // ==========================================
    // STEP 7: NOTIFY THE REQUESTER
    // ==========================================
    // We only trigger the Infobip email to the user if the ticket JUST reached a final terminal state.
    // This prevents sending them two emails if the CFO and Manager both approve.
    if (user_email && (finalIvantiStatus === 'Approved' || finalIvantiStatus === 'Approval Rejected') && currentStatus !== finalIvantiStatus) {
      // Choose template based on final decision
      const templateId = decision === 'approved' ? '205000000088607' : '205000000088608';
      const cleanInfobipUrl = (process.env.infobip_base_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const emailFormData = new FormData();
      
      emailFormData.append("from", "IT Service Desk <notifications@procuri.tech>");
      emailFormData.append("to", user_email);
      emailFormData.append("templateId", templateId);

      await fetch(`https://${cleanInfobipUrl}/email/3/send`, {
        method: 'POST',
        headers: { 'Authorization': `App ${process.env.infobip_api_key}` },
        body: emailFormData
      });
    }

    // ==========================================
    // STEP 8: RENDER SUCCESS SCREEN
    // ==========================================
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
