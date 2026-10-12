/**
 * image.js — บีบอัดรูปก่อนอัปโหลด
 *
 * กล้องมือถือถ่ายได้ 3-8 MB แต่ Supabase ฟรีมีพื้นที่ 1 GB
 * ย่อเหลือด้านยาว 800px เป็น WebP (~40-60 KB) — มือถือเก่าที่ทำ WebP ไม่ได้ใช้ JPEG แทน
 */

const ImageUtil = (() => {

  /** อ่าน EXIF orientation — รูปจาก iPhone จะตะแคงถ้าไม่แก้ */
  function getOrientation(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const view = new DataView(e.target.result);
        if (view.getUint16(0, false) !== 0xFFD8) return resolve(1);

        const length = view.byteLength;
        let offset = 2;

        while (offset < length) {
          if (view.getUint16(offset + 2, false) <= 8) return resolve(1);
          const marker = view.getUint16(offset, false);
          offset += 2;

          if (marker === 0xFFE1) {
            if (view.getUint32(offset += 2, false) !== 0x45786966) return resolve(1);
            const little = view.getUint16(offset += 6, false) === 0x4949;
            offset += view.getUint32(offset + 4, little);
            const tags = view.getUint16(offset, little);
            offset += 2;
            for (let i = 0; i < tags; i++) {
              if (view.getUint16(offset + i * 12, little) === 0x0112) {
                return resolve(view.getUint16(offset + i * 12 + 8, little));
              }
            }
          } else if ((marker & 0xFF00) !== 0xFF00) {
            break;
          } else {
            offset += view.getUint16(offset, false);
          }
        }
        resolve(1);
      };
      reader.onerror = () => resolve(1);
      reader.readAsArrayBuffer(file.slice(0, 64 * 1024));
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดไฟล์รูปไม่ได้')); };
      img.src = url;
    });
  }

  function drawOriented(img, orientation, maxEdge) {
    let { width, height } = img;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);

    const swap = orientation >= 5 && orientation <= 8;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? height : width;
    canvas.height = swap ? width : height;

    const ctx = canvas.getContext('2d');
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, height, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, height, width); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, width); break;
    }
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  }

  function toBlob(canvas, type, quality) {
    return new Promise(resolve =>
      canvas.toBlob(b => resolve(b), type, quality));
  }

  /**
   * บีบอัดจนได้ขนาดที่รับได้ ลองคุณภาพลดหลั่นกันไป
   * คืน { blob, mimeType, bytes, previewUrl }
   */
  async function compress(file, opts = {}) {
    const maxEdge = opts.maxEdge || CONFIG.IMAGE.MAX_EDGE;
    const steps = opts.qualitySteps || CONFIG.IMAGE.QUALITY_STEPS;
    const maxBytes = opts.maxBytes || CONFIG.IMAGE.MAX_BYTES;

    if (!file.type.startsWith('image/')) {
      throw new Error('กรุณาเลือกไฟล์รูปภาพ');
    }

    const orientation = await getOrientation(file);
    const img = await loadImage(file);
    const canvas = drawOriented(img, orientation, maxEdge);

    // เบราว์เซอร์ที่ทำ WebP ไม่ได้ (Safari รุ่นเก่า) จะคืน PNG มาแทน — เช็กแล้วถอยไป JPEG
    const probe = await toBlob(canvas, 'image/webp', steps[0]);
    const type = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';

    let blob = null;
    for (const q of steps) {
      blob = (type === 'image/webp' && q === steps[0]) ? probe : await toBlob(canvas, type, q);
      if (blob && blob.size <= maxBytes) break;
    }

    if (!blob) throw new Error('บีบอัดรูปไม่สำเร็จ');
    if (blob.size > maxBytes) {
      throw new Error('รูปใหญ่เกินไป กรุณาถ่ายใหม่ให้ใกล้ขึ้นหรือแสงสว่างกว่านี้');
    }

    return {
      blob,
      mimeType: type,
      bytes: blob.size,
      previewUrl: URL.createObjectURL(blob)
    };
  }

  return { compress, getOrientation };
})();
