export const MAX_CLIP_CHARACTERS = 2_000_000;

// Fetch exposes the decoded body, including decompressed responses. Bound each
// decoded piece before accumulating it; preserve the existing UTF-16 limit.
export async function readClippableHtml(response) {
  let reader;
  try {
    if (!response.ok) throw new Error(`Could not fetch page (${response.status})`);
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('html')) throw new Error('The page did not return HTML');
    if (!response.body) return '';
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let length = 0;
    const append = text => {
      if (!text) return;
      length += text.length;
      if (length > MAX_CLIP_CHARACTERS) throw new Error('The page is too large to clip');
      parts.push(text);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // A transport chunk may itself be large. Decode in small bounded slices.
      for (let offset = 0; offset < value.byteLength; offset += 16384) {
        append(decoder.decode(value.subarray(offset, offset + 16384), { stream: true }));
      }
    }
    append(decoder.decode());
    return parts.join('');
  } catch (error) {
    try { await (reader ? reader.cancel() : response.body?.cancel()); } catch { /* Preserve the original fetch error. */ }
    throw error;
  } finally { reader?.releaseLock(); }
}
