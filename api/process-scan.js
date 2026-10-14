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
    let assignedUserRecId = null;
    let ticketRecId = null;

    // 1. DYNAMIC LOOKUP: Pull Ticket & User ID
    if (!assignedEmail.includes('@')) {
      ticketNumber = assignedEmail;
      
      const ticketQuery = encodeURIComponent(`ServiceReqNumber eq ${ticketNumber}`);
      const ticketUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/ServiceReqs?$filter=${ticketQuery}&$top=1`;
      
      const ticketRes = await fetch(ticketUrl, {
        method: 'GET',
        headers: { 'Authorization': process.env.ivanti_api_key }
      });
      const ticketData = await ticketRes.json();
      
      if (ticketData.value && ticketData.value.length > 0) {
        assignedEmail = ticketData.value[0].Email || assignedEmail;
        // Capture the 32-character User ID and the Ticket ID
        assignedUserRecId = ticketData.value[0].ProfileLink_RecID;
        ticketRecId = ticketData.value[0].RecId;
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

    // 3. Update the Asset in Ivanti (Status + Ownership)
    const patchAssetBody = { Status: action };
    if (assignedUserRecId) {
        // Use the RecId to successfully assign ownership
        patchAssetBody.ivnt_AssignedUser = assignedUserRecId; 
    }

    const patchUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis('${recId}')`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': process.env.ivanti_api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patchAssetBody)
    });

    // 4. Update the Service Request (Status + Fulfillment Note)
    if (ticketRecId) {
        // Change ticket status to Fulfilled
        const patchTicketUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/ServiceReqs('${ticketRecId}')`;
        await fetch(patchTicketUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': process.env.ivanti_api_key,
            'Content-Type': 'application/json'
          },
          // Note: If your system uses a different status name (e.g., 'Closed' or 'Completed'), update it here
          body: JSON.stringify({ Status: 'Fulfilled' })
        });

        // Add a permanent Journal Note with the hardware details
        const journalUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/Journal__Notes`;
        await fetch(journalUrl, {
          method: 'POST',
          headers: {
            'Authorization': process.env.ivanti_api_key,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ParentLink_Category: 'ServiceReq',
            ParentLink_RecID: ticketRecId,
            Subject: 'Hardware Asset Fulfilled via Barcode Scan',
            NotesBody: `Asset successfully assigned.\n\nManufacturer: ${manufacturer}\nModel: ${model}\nSerial Number: ${cleanBarcode}\nAsset Tag: ${assetTag}`
          })
        });
    }

    // 5. Send Collection Email via Infobip
    if (assignedEmail && assignedEmail.includes('@')) {
        const infobipEmailUrl = `https://${process.env.infobip_base_url}/email/3/send`;
        
        const formData = new FormData();
        formData.append('from', 'IT Support <it-support@yourdomain.com>'); 
        formData.append('to', assignedEmail);
        formData.append('subject', 'Hardware Ready for Collection');
        
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
