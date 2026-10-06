// Serves the SHEET_CONFIG Vercel env var to the dashboard as JSON.
// Public/index.html loads this synchronously at the top of <head> and
// exposes it as window.SHEET_CFG before any other script runs.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const raw = process.env.SHEET_CONFIG;
  if (!raw) {
    res.status(500).json({ error: 'SHEET_CONFIG env var is not set' });
    return;
  }
  try {
    res.status(200).json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: 'SHEET_CONFIG is not valid JSON: ' + e.message });
  }
};
