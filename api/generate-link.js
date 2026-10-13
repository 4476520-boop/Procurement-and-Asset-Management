const jwt = require('jsonwebtoken');

export default function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, action } = req.body;

  if (!email || !action) {
    return res.status(400).json({ error: 'Missing email or action' });
  }

  // Encrypt the data into a token that expires in 1 hour
  const token = jwt.sign({ email, action }, process.env.JWT_SECRET, { expiresIn: '1h' });
  
  // Construct the secure URL
  const secureUrl = `https://scanner.procuri.tech/?t=${token}`;

  return res.status(200).json({ secure_url: secureUrl });
}
