const ngrok = require("@ngrok/ngrok");

async function forwardToApp() {
  const addr = process.env.NGROK_ADDR;
  if (!addr) throw new Error('NGROK_ADDR must be configured to start a tunnel');
  const domain = process.env.NGROK_DOMAIN;
  const forwarder = await ngrok.forward({
    addr,
    authtoken_from_env: true,
    ...(domain ? { domain } : {}),
  });
  console.log(`Available at: ${forwarder.url()}`);
}

forwardToApp();
