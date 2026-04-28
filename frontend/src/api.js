const root = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '';
export const API_ROOT = root;
export const API = root ? `${root}/api` : '/api';

export const apiUrl = (path) => {
  if (!path) return API;
  if (!path.startsWith('/')) path = `/${path}`;

  if (path.startsWith('/api')) {
    return root ? `${root}${path}` : path;
  }

  return `${API}${path}`;
};

export const buildInternalTransferPayload = (recipientIdentifier, amount, asset = 'USDC', recipientId = null) => {
  const payload = {
    amount: parseFloat(amount),
    asset,
  };

  const identifier = String(recipientIdentifier || '').trim();
  if (identifier) {
    payload.recipient = identifier;
    payload.recipientEmail = identifier.includes('@') ? identifier.toLowerCase() : undefined;

    const digits = identifier.replace(/[^0-9]/g, '');
    if (/^\d+$/.test(identifier)) {
      const numericValue = Number(identifier);
      if (!Number.isNaN(numericValue)) {
        payload.recipientId = numericValue;
        payload.toUserId = numericValue;
      }
      if (digits) {
        payload.recipientPhone = digits;
      }
    } else if (digits.length >= 7) {
      payload.recipientPhone = digits;
    }
  }

  if (recipientId) {
    payload.recipientId = recipientId;
    payload.toUserId = recipientId;
  }

  return payload;
};
