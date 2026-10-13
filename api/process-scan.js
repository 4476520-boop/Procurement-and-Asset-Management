const jwt = require('jsonwebtoken');

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, barcode } = req.body;

  try {
    // 1. Decrypt and verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { email, action } = decoded;

    // 2. Locate the Asset in Ivanti
    const ivantiUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis?$filter=ivnt_AssetTag eq '${barcode}'&$top=1`;
    const getResponse = await fetch(ivantiUrl, {
      method: 'GET',
      headers: { 'Authorization': process.env.IVANTI_API_KEY }
    });
    const getData = await getResponse.json();
    
    if (!getData.value || getData.value.length === 0) {
      return res.status(404).json({ error: 'Asset not found in database' });
    }
    const recId = getData.value[0].RecId;

    // 3. Update the Asset in Ivanti
    const patchUrl = `https://dev-thinktanks.trysaasiteu.com/api/odata/businessobject/cis('${recId}')`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': process.env.IVANTI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ Status: action })
    });

    // 4. Send Confirmation via Infobip
    const infobipUrl = `https://${process.env.INFOBIP_BASE_URL}/messages-api/1/messages`;
    await fetch(infobipUrl, {
      method: 'POST',
      headers: {
        'Authorization': `App ${process.env.INFOBIP_API_KEY}`,
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
    console.error(error);
    return res.status(500).json({ error: 'Token invalid or server error' });
  }
}
