(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const { HOME_SECTION_ID } = OWP.constants;

  const ensureHomeSection = (container) => {
    let section = document.getElementById(HOME_SECTION_ID);
    if (!section) {
      section = document.createElement('div');
      section.id = HOME_SECTION_ID;
      section.className = 'verticalSection verticalSection-extrabottompadding';
      container.prepend(section);
    }
    if (!state.rooms || state.rooms.length === 0) {
      if (section.parentNode) section.remove();
      return null;
    }
    let itemsContainer = section.querySelector('.itemsContainer');
    if (!itemsContainer) {
      const titleContainer = document.createElement('div');
      titleContainer.className = 'sectionTitleContainer sectionTitleContainer-cards padded-left padded-right';
      const title = document.createElement('h2');
      title.className = 'sectionTitle sectionTitle-cards';
      const icon = document.createElement('span');
      icon.className = 'material-icons sectionTitleIcon';
      icon.style.marginRight = '8px';
      icon.textContent = 'groups';
      title.append(icon, document.createTextNode(' Watch Parties'));
      titleContainer.appendChild(title);
      const scroller = document.createElement('div');
      scroller.className = 'emby-scroller';
      scroller.dataset.horizontal = 'true';
      scroller.dataset.centerfocus = 'true';
      itemsContainer = document.createElement('div', 'emby-itemscontainer');
      itemsContainer.setAttribute('is', 'emby-itemscontainer');
      itemsContainer.className = 'itemsContainer scrollSlider focuscontainer-x padded-left padded-right';
      scroller.appendChild(itemsContainer);
      section.replaceChildren(titleContainer, scroller);
    }
    return itemsContainer;
  };

  const reconcileCards = (itemsContainer, rooms) => {
    const existingCards = new Map();
    itemsContainer.querySelectorAll('.owp-room-card').forEach(card => {
      existingCards.set(card.dataset.roomId, card);
    });
    const currentRoomIds = new Set(rooms.map(r => r.id));
    existingCards.forEach((card, roomId) => {
      if (!currentRoomIds.has(roomId)) {
        card.remove();
      }
    });
    rooms.forEach((room, index) => {
      const existing = existingCards.get(room.id);
      if (existing) {
        if (existing.dataset.count !== String(room.count)) {
          existing.dataset.count = String(room.count);
          const countEl = existing.querySelector('.innerCardFooter .cardText');
          if (countEl) {
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.style.cssText = 'font-size:14px;vertical-align:middle;';
            icon.textContent = 'groups';
            countEl.replaceChildren(icon, document.createTextNode(` ${String(room.count)} watching`));
          }
        }
      } else {
        itemsContainer.appendChild(ui.createRoomCard(room, index));
      }
    });
  };

  const renderHomeWatchParties = () => {
    if (!utils.isHomeView()) return;
    const container = document.querySelector('.homeSectionsContainer') || document.querySelector('#indexPage');
    if (!container) return;
    const itemsContainer = ensureHomeSection(container);
    if (!itemsContainer) return;
    reconcileCards(itemsContainer, state.rooms);
  };

  Object.assign(ui, { renderHomeWatchParties });
})();
