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
