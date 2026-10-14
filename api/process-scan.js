const jwt = require('jsonwebtoken');

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, barcode } = req.body;

  try {
    // Left uppercase as requested
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { email, action } = decoded;

    // 1. Locate the Asset in Ivanti (lowercase API key)
    const cleanBarcode = barcode.trim();
    const filterQuery = encodeURIComponent(`SerialNumber eq '${cleanBarcode}'`);
    const ivantiUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis?$filter=${filterQuery}&$top=1`;
    
    console.log("Searching Ivanti URL:", ivantiUrl);

    const getResponse = await fetch(ivantiUrl, {
      method: 'GET',
      headers: { 'Authorization': process.env.ivanti_api_key }
    });
    const getData = await getResponse.json();
    
    console.log("Ivanti Search Response:", JSON.stringify(getData));
    
    if (!getData.value || getData.value.length === 0) {
      return res.status(404).json({ error: 'Asset not found in database' });
    }
    const recId = getData.value[0].RecId;

    // 2. Update the Asset in Ivanti (lowercase API key)
    const patchUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis('${recId}')`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': process.env.ivanti_api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ Status: action })
    });

    // 3. Send Confirmation via Infobip (lowercase base URL and API key)
    const infobipUrl = `https://${process.env.infobip_base_url}/messages-api/1/messages`;
    await fetch(infobipUrl, {
      method: 'POST',
      headers: {
        'Authorization': `App ${process.env.infobip_api_key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        messages: [{
          destinations: [{ to: email }],
          text: `Success! Asset ${barcode} is now ${action}.`
        }]
      })
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Process Scan Error:", error);
    return res.status(500).json({ error: 'Token invalid or server error' });
  }
};
