window.electron.receive('update-progress', (progress) => {
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const status = document.getElementById('status');

  if (progress.status === 'downloading') {
    const percent = ((progress.downloaded / progress.total) * 100).toFixed(1);
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
    status.textContent = 'Downloading...';
    status.className = '';
  } else if (progress.status === 'finished') {
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
    status.textContent = 'Download Complete!';
    status.className = 'success';
  } else if (progress.status === 'error') {
    status.textContent = `Error: ${progress.message}`;
    status.className = 'error';
  }
});
