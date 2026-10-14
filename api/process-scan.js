const jwt = require('jsonwebtoken');

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, barcode } = req.body;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { action, target_user } = decoded;

    let assignedEmail = target_user.trim();
    let ticketNumber = null;

    // 1. DYNAMIC LOOKUP: If input is a Ticket Number (no '@' symbol), pull the email from Ivanti
    if (!assignedEmail.includes('@')) {
      ticketNumber = assignedEmail;
      
      const ticketQuery = encodeURIComponent(`ServiceReqNumber eq ${ticketNumber}`);
      const ticketUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/ServiceReqs?$filter=${ticketQuery}&$top=1`;
      
      console.log("Searching Ticket URL:", ticketUrl);
      
      const ticketRes = await fetch(ticketUrl, {
        method: 'GET',
        headers: { 'Authorization': process.env.ivanti_api_key }
      });
      const ticketData = await ticketRes.json();
      
      if (ticketData.value && ticketData.value.length > 0) {
        // Updated to use exactly your 'Email' field
        assignedEmail = ticketData.value[0].Email || assignedEmail;
        console.log("Extracted email from ticket:", assignedEmail);
      } else {
        console.log("Warning: Service Request not found in Ivanti.");
      }
    }

    // 2. Locate the Asset in Ivanti
    const cleanBarcode = barcode.trim();
    const filterQuery = encodeURIComponent(`SerialNumber eq '${cleanBarcode}'`);
    const ivantiUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis?$filter=${filterQuery}&$top=1`;
    
    const getResponse = await fetch(ivantiUrl, {
      method: 'GET',
      headers: { 'Authorization': process.env.ivanti_api_key }
    });
    const getData = await getResponse.json();
    
    if (!getData.value || getData.value.length === 0) {
      return res.status(404).json({ error: 'Asset not found in database' });
    }
    
    const asset = getData.value[0];
    const recId = asset.RecId;
    
    const manufacturer = asset.Manufacturer || 'Hardware';
    const model = asset.Model || 'Device';
    const assetTag = asset.AssetTag || asset.ivnt_AssetTag || 'Unknown Tag';

    // 3. Update the Asset in Ivanti (Using your exact ivnt_AssignedUser field)
    const patchUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis('${recId}')`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': process.env.ivanti_api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        Status: action,
        ivnt_AssignedUser: assignedEmail 
      })
    });

    // 4. Send Collection Email via Infobip
    if (assignedEmail && assignedEmail.includes('@')) {
        const infobipEmailUrl = `https://${process.env.infobip_base_url}/email/3/send`;
        
        const formData = new FormData();
        formData.append('from', 'IT Support <it-support@procuri.tech>'); 
        formData.append('to', assignedEmail);
        formData.append('subject', 'Hardware Ready for Collection');
        
        // Dynamically includes the ticket number in the email if one was provided
        const ticketText = ticketNumber ? ` for ticket ${ticketNumber}` : '';
        formData.append('text', `Your IT hardware request${ticketText} has been fulfilled.\n\nAn ${manufacturer} ${model} (Asset Tag: ${assetTag}) is ready for collection at the IT Desk.`);

        await fetch(infobipEmailUrl, {
          method: 'POST',
          headers: {
            'Authorization': `App ${process.env.infobip_api_key}`
          },
          body: formData
        });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Process Scan Error:", error);
    return res.status(500).json({ error: 'Token invalid or server error' });
  }
};
