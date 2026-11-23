// Paste/evaluate in the dashboard page (http://localhost:3311) to attach the local dev wallet.
// Forwards EIP-1193 requests to scripts/dev-wallet.mjs; holds no key itself.
(() => {
  const URL = "http://127.0.0.1:8549";
  const listeners = {};
  let seq = 0;
  const emit = (event, value) => (listeners[event] || []).forEach((fn) => fn(value));
  window.ethereum = {
    isDevWallet: true,
    async request({ method, params }) {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ++seq, method, params }),
      });
      const msg = await res.json();
      if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
      if (method === "wallet_switchEthereumChain") emit("chainChanged", params[0].chainId);
      return msg.result;
    },
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
  };
  return "dev wallet attached";
})();
