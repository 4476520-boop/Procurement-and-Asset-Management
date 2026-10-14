const jwt = require('jsonwebtoken');

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Extract the new target_user variable from the Infobip payload
  const { email, action, target_user } = req.body;

  if (!email || !action) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 2. Encrypt target_user inside the token alongside the admin email and action
    const token = jwt.sign(
      { 
        email, 
        action, 
        target_user: target_user || 'None' 
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const secureUrl = `https://scanner.procuri.tech/?t=${token}`;

    return res.status(200).json({ secure_url: secureUrl });
  } catch (error) {
    console.error("Token Generation Error:", error);
    return res.status(500).json({ error: 'Failed to generate token' });
  }
};
