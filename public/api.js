export async function api(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || typeof body === 'string') opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

export const uploadPdf = (file, projectId) =>
  api('POST', '/api/pdfs', file, {
    'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name), ...(projectId ? { 'X-Project': projectId } : {}),
  });

// A file that is not a PDF (an image, HTML, text, Markdown), turned into a PDF by the desktop app.
export const captureFile = (file, projectId) =>
  api('POST', '/api/capture/file', file, {
    'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), ...(projectId ? { 'X-Project': projectId } : {}),
  });
// A web page, saved as a PDF snapshot by the desktop app.
export const captureWeb = (url, projectId) => api('POST', '/api/capture/web', { url, project: projectId || '' });

export const uploadImage = (blob) =>
  api('POST', '/api/images', blob, { 'Content-Type': blob.type || 'image/png' });
