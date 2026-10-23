const filterButtons = [...document.querySelectorAll('[data-filter]')];
const cards = [...document.querySelectorAll('.list-tool')];
const emptyState = document.querySelector('.empty-state');

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    let visible = 0;

    filterButtons.forEach((item) => item.classList.toggle('active', item === button));
    cards.forEach((card) => {
      const show = filter === 'all' || card.dataset.type === filter;
      card.hidden = !show;
      if (show) visible += 1;
    });

    emptyState.hidden = visible !== 0;
  });
});

