/**
 * Manages UI relevant to bad words censorship
 */
'use strict';

import { getIfLocalStorageIsAvailable } from '../utils/is_local_storage_available';
import { badWordList } from './bad_word_list.js';
const STORAGE_KEY_CUSTOM_LIST = 'stringifiedbadWordListArrayView';
const isLocalStorageAvailable = getIfLocalStorageIsAvailable();

const STORAGE_KEY_DEFAULT_FILTER_TOGGLE = 'isDefaultBadWordFilterEnabled';

const defaultFilterToggle = document.getElementById(
  'basic-chat-filter-checkbox'
);
const customBadWordsTableContainer = document.getElementById(
  'blocked-bad-words-table-container'
);
const customBadWordsTableTbody = document.querySelector(
  'table.blocked-bad-words-table tbody'
);
const deleteCustomWordBtn = document.querySelector(
  'table.blocked-bad-words-table .delete-btn'
);
const customBadWordsCountSpan = document.getElementById(
  'number-of-bad-words-addresses'
);

const addCustomWordBtn = document.getElementById('add-custom-word-btn');
const newCustomWordInput = document.getElementById('new-custom-word-input');

export function setUpUIForManagingBadWords() {
  if (!isLocalStorageAvailable) {
    defaultFilterToggle.parentElement.classList.add('hidden');
    customBadWordsTableContainer.classList.add('hidden');
    return;
  }

  setUpDefaultFilterToggle();
  setUpCustomFilterManagement();
}

/**
 * Set up toggle for using list of basic bad words at chat_filter.js
 */
function setUpDefaultFilterToggle() {
  let isEnabled = true;
  try {
    const storedToggleState = window.localStorage.getItem(
      STORAGE_KEY_DEFAULT_FILTER_TOGGLE
    );
    if (storedToggleState !== null) {
      isEnabled = storedToggleState === 'true';
    }
  } catch (err) {
    console.log(err);
  }
  // @ts-ignore
  defaultFilterToggle.checked = isEnabled;
  badWordList.willUseBasicBadWords = isEnabled;
  defaultFilterToggle.addEventListener('change', () => {
    try {
      // @ts-ignore
      window.localStorage.setItem(
        STORAGE_KEY_DEFAULT_FILTER_TOGGLE,
        // @ts-ignore
        String(defaultFilterToggle.checked)
      );
    } catch (err) {
      console.log(err);
    }
  });
}

/**
 * Set up table of bad words(delete, register)
 */
function setUpCustomFilterManagement() {
  // @ts-ignore
  deleteCustomWordBtn.disabled = true;
  if (!isLocalStorageAvailable) {
    return;
  }

  let stringifiedList = null;
  try {
    stringifiedList = window.localStorage.getItem(STORAGE_KEY_CUSTOM_LIST);
  } catch (err) {
    console.log(err);
  }

  if (stringifiedList !== null) {
    const arrayView = JSON.parse(stringifiedList);
    if (arrayView.length > 0 && arrayView[0].length !== 2) {
      window.localStorage.removeItem(STORAGE_KEY_CUSTOM_LIST);
      location.reload();
    } else {
      badWordList.readArrayViewAndUpdate(arrayView);
    }
  }

  displayCustomBadWords(badWordList.createArrayView());
  displayNumberOfCustomBadWords();

  let lastSelectedIndex = -1;
  document.body.addEventListener('click', (event) => {
    const target = event.target;
    if (
      // @ts-ignore
      customBadWordsTableTbody.contains(target) &&
      // @ts-ignore
      target.tagName === 'TD'
    ) {
      // @ts-ignore
      const trElement = target.parentElement;
      const currentIndex = trElement.sectionRowIndex;

      if (event.shiftKey && lastSelectedIndex !== -1) {
        if (!event.ctrlKey) {
          clearSelection();
        }
        const start = Math.min(lastSelectedIndex, currentIndex);
        const end = Math.max(lastSelectedIndex, currentIndex);
        const rows = customBadWordsTableTbody.getElementsByTagName('tr');
        for (let i = start; i <= end; i++) {
          if (rows[i]) {
            rows[i].classList.add('selected');
          }
        }
      } else {
        if (!event.ctrlKey) {
          clearSelection();
        }
        trElement.classList.toggle('selected');
        lastSelectedIndex = currentIndex;
      }
    } else {
      if (!event.ctrlKey && !event.shiftKey) {
        clearSelection();
      }
    }

    // @ts-ignore
    deleteCustomWordBtn.disabled =
      !customBadWordsTableTbody.querySelector('.selected');
  });
  deleteCustomWordBtn.addEventListener('click', () => {
    lastSelectedIndex = -1;
    const selectedTRElements =
      customBadWordsTableTbody.querySelectorAll('.selected');
    for (let i = selectedTRElements.length - 1; i >= 0; --i) {
      // @ts-ignore
      badWordList.removeAt(Number(selectedTRElements[i].dataset.index));
    }
    try {
      window.localStorage.setItem(
        'stringifiedbadWordListArrayView',
        JSON.stringify(badWordList.createArrayView())
      );
    } catch (err) {
      console.log(err);
    }
    displayCustomBadWords(badWordList.createArrayView());
    displayNumberOfCustomBadWords();
  });
  addCustomWordBtn.addEventListener('click', () => {
    lastSelectedIndex = -1;
    // @ts-ignore
    const cleanWord = newCustomWordInput.value
      .toLowerCase()
      .replace(/[^\p{L}\p{Emoji}]/gu, ''); // Words or emojis will be saved
    if (!cleanWord || badWordList.isFull()) {
      return;
    }
    badWordList.AddBadWords(cleanWord);
    try {
      window.localStorage.setItem(
        STORAGE_KEY_CUSTOM_LIST,
        JSON.stringify(badWordList.createArrayView())
      );
    } catch (err) {
      console.log(err);
    }
    displayCustomBadWords(badWordList.createArrayView());
    displayNumberOfCustomBadWords();
    // @ts-ignore
    newCustomWordInput.value = '';
  });
}

/**
 * Display the given bad word list array view.
 * @param {[string, number][]} badWords
 */
function displayCustomBadWords(badWords) {
  while (customBadWordsTableTbody.firstChild) {
    customBadWordsTableTbody.removeChild(customBadWordsTableTbody.firstChild);
  }
  // Display the given list
  badWords.forEach((badWord, index) => {
    const trElement = document.createElement('tr');
    const tdElementForWord = document.createElement('td');
    const tdElementForTime = document.createElement('td');
    trElement.appendChild(tdElementForWord);
    trElement.appendChild(tdElementForTime);
    trElement.dataset.index = String(index);
    tdElementForWord.textContent = badWord[0];
    tdElementForTime.textContent = new Date(badWord[1]).toLocaleString();
    customBadWordsTableTbody.appendChild(trElement);
  });
}

/**
 * Display the number of bad words in the list
 */
function displayNumberOfCustomBadWords() {
  customBadWordsCountSpan.textContent = String(badWordList.length);
}

/**
 * Clear all selected rows in the bad words table
 */
function clearSelection() {
  Array.from(
    // @ts-ignore
    customBadWordsTableTbody.getElementsByTagName('tr')
  ).forEach((elem) => {
    elem.classList.remove('selected');
  });
}
