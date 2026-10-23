const copyButton = document.querySelector('#copyHash');
const hashValue = document.querySelector('#hashValue');
const downloadButtons = [...document.querySelectorAll('[data-download]')];
let downloadRunning = false;

copyButton?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(hashValue.textContent.trim());
    copyButton.textContent = '已复制';
    setTimeout(() => { copyButton.textContent = '复制校验值'; }, 1800);
  } catch {
    copyButton.textContent = '请手动复制';
  }
});

downloadButtons.forEach((button) => {
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    if (downloadRunning) return;
    downloadRunning = true;

    const labels = downloadButtons.map((item) => item.innerHTML);
    downloadButtons.forEach((item) => {
      item.setAttribute('aria-busy', 'true');
      item.textContent = '正在准备下载…';
    });

    try {
      const manifestResponse = await fetch('files/chunks/manifest.json');
      if (!manifestResponse.ok) throw new Error('manifest');
      const manifest = await manifestResponse.json();
      const buffers = [];

      for (let index = 0; index < manifest.parts.length; index += 1) {
        const part = manifest.parts[index];
        const response = await fetch(`files/chunks/${part.file}`);
        if (!response.ok) throw new Error(part.file);
        buffers.push(await response.arrayBuffer());
        const progress = Math.round(((index + 1) / manifest.parts.length) * 100);
        downloadButtons.forEach((item) => { item.textContent = `正在下载 ${progress}%`; });
      }

      const url = URL.createObjectURL(new Blob(buffers, {type: 'application/zip'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = manifest.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      alert('下载准备失败，请稍后重试，或改用即将接入的网盘下载。');
    } finally {
      downloadButtons.forEach((item, index) => {
        item.removeAttribute('aria-busy');
        item.innerHTML = labels[index];
      });
      downloadRunning = false;
    }
  });
});

