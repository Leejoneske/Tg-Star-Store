
export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!process.env.WALLET_ADDRESS) {
      return res.status(500).json({
        success: false,
        error: 'Wallet address not configured'
      });
    }
    
    res.json({
      success: true,
      walletAddress: process.env.WALLET_ADDRESS
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}
