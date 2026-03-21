/**
 * app.js  –  Global Pedigree Chart
 * =================================
 * Sections:
 *   1. State & Constants
 *   2. Firebase Auth
 *   3. UI helpers (toast, modal, tabs)
 *   4. Firestore real-time listeners
 *   5. Form handlers (add person, add relationship)
 *   6. D3 graph – initialise, render, update
 *   7. D3 graph – layout (hierarchical force)
 *   8. D3 graph – drag handlers
 *   9. Zoom / pan controls
 *  10. Node interaction (click → detail panel)
 *  11. Admin functions (users, conflicts)
 *  12. Left-panel panel resize handle
 *  13. Utility helpers
 */

/* ════════════════════════════════════════════════════════════
   1. STATE & CONSTANTS
════════════════════════════════════════════════════════════ */

// Firebase shorthand references (populated after firebase.initializeApp in firebase-config.js)
const auth = firebase.auth();
const db   = firebase.firestore();

// Application state
let currentUser       = null;   // firebase.User
let currentProfile    = null;   // Firestore /users/{uid} document data
let selectedNodeId    = null;   // currently selected node id
let selectedLinkId    = null;   // currently selected link id
let activeTracePath   = null;   // array of path steps when trace is active
let currentSuggestions  = [];   // suggestions computed by generateSuggestions()
let pickMode            = null; // { field: 'rel-p1'|'rel-p2'|'trace-p1'|'trace-p2', label } when active
let _nodeTapped         = false; // guard against mobile ghost-click on SVG background
let _nodeTapTimer       = null;  // timer handle for clearing _nodeTapped
let _infoPanelShownAt   = 0;     // timestamp (ms) when info panel was last shown

// Graph data (kept in sync via onSnapshot)
const graphData = {
  nodes: [],   // { id, name, gender, dateOfBirth, createdBy, isVerified, x?, y?, fx?, fy? }
  links: []    // { id, person1Id, person2Id, relationshipType, isReverse, conflicted, ... }
};

// Lookup maps for O(1) access during render/tick
let nodeById = new Map();

// D3 objects
let svgEl, svgSel, zoomBehaviour, rootGroup, linksLayer, nodesLayer, simulation;

// Track whether the graph has been rendered once (to avoid re-centering on every update)
let graphInitialised = false;

// Which link-type categories are currently hidden (values: 'parent','sibling','spouse','in-law')
const hiddenLinkTypes = new Set();

// Node visual dimensions
const NODE_W  = 100;   // rectangle width
const NODE_H  = 60;    // rectangle height
const NODE_RX = 14;    // corner radius

// Colours by gender
const GENDER_COLORS = {
  male:   '#3b82f6',
  female: '#ec4899',
  other:  '#8b5cf6'
};

// Link stroke colour by relationship type
const LINK_COLORS = {
  parent:          '#ef4444',
  child:           '#ef4444',
  sibling:         '#3b82f6',
  spouse:          '#a855f7',
  'parent-in-law': '#0d9488',
  'child-in-law':  '#0d9488',
  'sibling-in-law':'#0d9488'
};

/* ════════════════════════════════════════════════════════════
   2. FIREBASE AUTH
════════════════════════════════════════════════════════════ */

auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    await loadProfile(user.uid);
  } else {
    currentUser    = null;
    currentProfile = null;
    showScreen('auth');
  }
});

async function login() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return showAuthMsg('Please fill in all fields.', 'error');
  try {
    clearAuthMsg();
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    showAuthMsg(friendlyAuthError(err.code), 'error');
  }
}

async function register() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!name || !email || !password) return showAuthMsg('Please fill in all fields.', 'error');
  if (password.length < 6) return showAuthMsg('Password must be at least 6 characters.', 'error');

  try {
    clearAuthMsg();
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const uid  = cred.user.uid;

    // Determine role: admin if email matches ADMIN_EMAIL constant or if no users exist yet
    const usersSnap = await db.collection('users').limit(1).get();
    const isFirst   = usersSnap.empty;
    const isAdmin   = isFirst || (typeof ADMIN_EMAIL !== 'undefined' && email.toLowerCase() === ADMIN_EMAIL.toLowerCase());

    await db.collection('users').doc(uid).set({
      uid,
      name,
      email,
      role:      isAdmin ? 'admin' : 'user',
      approved:  isAdmin ? true    : false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    if (!isAdmin) {
      showAuthMsg('Account created! Waiting for admin approval.', 'info');
    }
  } catch (err) {
    showAuthMsg(friendlyAuthError(err.code), 'error');
  }
}

async function logout() {
  await auth.signOut();
  location.reload();
}

async function loadProfile(uid) {
  try {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      // Profile not yet written (rare race) – retry once after a short delay
      setTimeout(() => loadProfile(uid), 1500);
      return;
    }
    currentProfile = doc.data();

    if (!currentProfile.approved) {
      showScreen('pending');
      return;
    }

    showScreen('app');
    bootApp();
  } catch (err) {
    console.error('loadProfile error:', err);
    showAuthMsg('Failed to load your profile. Please refresh.', 'error');
    showScreen('auth');
  }
}

/* ════════════════════════════════════════════════════════════
   3. UI HELPERS
════════════════════════════════════════════════════════════ */

function showScreen(name) {
  document.getElementById('auth-screen').style.display    = name === 'auth'    ? 'flex' : 'none';
  document.getElementById('pending-screen').style.display = name === 'pending' ? 'flex' : 'none';
  document.getElementById('app').style.display            = name === 'app'     ? 'flex' : 'none';
}

function showTab(name) {
  document.getElementById('login-form').style.display    = name === 'login'    ? 'flex' : 'none';
  document.getElementById('register-form').style.display = name === 'register' ? 'flex' : 'none';
  document.getElementById('tab-login').classList.toggle('active',    name === 'login');
  document.getElementById('tab-register').classList.toggle('active', name === 'register');
  clearAuthMsg();
}

function showAuthMsg(msg, type) {
  const el = document.getElementById('auth-msg');
  el.textContent = msg;
  el.className   = type; // 'error' | 'info'
}
function clearAuthMsg() {
  const el = document.getElementById('auth-msg');
  el.className   = '';
  el.textContent = '';
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast' + (type ? ' ' + type : '');
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2800);
}

function setLoading(visible) {
  document.getElementById('loading-overlay').style.display = visible ? 'flex' : 'none';
}

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':    'No account found with that email.',
    'auth/wrong-password':    'Incorrect password.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/invalid-email':     'Please enter a valid email address.',
    'auth/weak-password':     'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/invalid-credential': 'Invalid email or password.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

/* ════════════════════════════════════════════════════════════
   4. BOOT APP  –  header, listeners, forms
════════════════════════════════════════════════════════════ */

function bootApp() {
  // Header
  document.getElementById('hdr-name').textContent = currentProfile.name;
  const badge = document.getElementById('hdr-badge');
  badge.textContent = currentProfile.role;
  badge.className   = 'role-badge ' + currentProfile.role;

  // Show admin controls
  if (currentProfile.role === 'admin') {
    document.getElementById('admin-section').style.display = 'block';
  }

  // Init D3 SVG before listeners fire (so updateGraph can render immediately)
  initGraph();

  // Attach form submit handlers
  document.getElementById('form-add-person').addEventListener('submit', handleAddPerson);
  document.getElementById('form-add-rel').addEventListener('submit', handleAddRelationship);
  document.getElementById('form-edit').addEventListener('submit', handleEditSave);

  // Start real-time Firestore listeners
  startListeners();

  // Resize handle for left panel
  initResizeHandle();
}

/* ════════════════════════════════════════════════════════════
   5. FIRESTORE REAL-TIME LISTENERS
════════════════════════════════════════════════════════════ */

let _nodesReady = false, _linksReady = false;

function startListeners() {
  setLoading(true);

  // ── nodes ──────────────────────────────────────────────
  db.collection('nodes').onSnapshot((snap) => {
    const existingPos = new Map(graphData.nodes.map(n => [n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy, vx: n.vx, vy: n.vy }]));

    graphData.nodes = snap.docs.map(doc => {
      const pos  = existingPos.get(doc.id) || {};
      return {
        id: doc.id,
        ...doc.data(),
        // Preserve physics state for existing nodes so they don't jump
        x:  pos.x  ?? (Math.random() - 0.5) * 600,
        y:  pos.y  ?? (Math.random() - 0.5) * 400,
        fx: pos.fx ?? null,
        fy: pos.fy ?? null,
        vx: pos.vx ?? 0,
        vy: pos.vy ?? 0
      };
    });

    nodeById = new Map(graphData.nodes.map(n => [n.id, n]));
    updatePeoplePanel();
    refreshPersonSelects();

    _nodesReady = true;
    if (_linksReady) { setLoading(false); updateGraph(); }
  }, (err) => { console.error('nodes listener:', err); setLoading(false); });

  // ── relationships ───────────────────────────────────────
  db.collection('relationships').onSnapshot((snap) => {
    graphData.links = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    _linksReady = true;
    if (_nodesReady) { setLoading(false); updateGraph(); }
  }, (err) => { console.error('links listener:', err); setLoading(false); });
}

/* ════════════════════════════════════════════════════════════
   5b. FORM HANDLERS
════════════════════════════════════════════════════════════ */

async function handleAddPerson(e) {
  e.preventDefault();
  const name   = document.getElementById('new-name').value.trim();
  const gender = document.getElementById('new-gender').value;
  const dob    = document.getElementById('new-dob').value || null;

  if (!name) return;

  try {
    const docRef = await db.collection('nodes').add({
      name,
      gender,
      dateOfBirth: dob,
      createdBy:   currentUser.uid,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      isVerified:  currentProfile.role === 'admin'
    });
    document.getElementById('form-add-person').reset();
    toast('Person added!', 'success');
    logActivity('add_person', { personId: docRef.id, personName: name, gender, dob });

    // If there are already other people, prompt to link
    if (graphData.nodes.length > 0) {
      openQuickLinkModal(docRef.id, name, gender);
    }
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

/* ── Quick-Link Modal (auto-opens after adding a person) ── */
let _quickLinkPersonId = null;

function openQuickLinkModal(newId, newName, newGender) {
  _quickLinkPersonId = newId;

  // Set the header label
  const genderIcon = newGender === 'female' ? '♀' : newGender === 'male' ? '♂' : '⚧';
  const color = newGender === 'female' ? '#ec4899' : newGender === 'male' ? '#3b82f6' : '#8b5cf6';
  document.getElementById('ql-new-person-label').innerHTML =
    `<span style="color:${color};font-weight:700;">${genderIcon} ${newName}</span>`;

  // Clear the other-person picker (it reads graphData.nodes dynamically, excluding _quickLinkPersonId)
  ppClearById('ql-other-person');

  // Reset rel type
  document.getElementById('ql-rel-type').value = '';

  document.getElementById('modal-quick-link').style.display = 'flex';
}

function closeQuickLinkModal() {
  document.getElementById('modal-quick-link').style.display = 'none';
  _quickLinkPersonId = null;
}

async function handleQuickLink() {
  const otherId = document.getElementById('ql-other-person').value;
  const relType = document.getElementById('ql-rel-type').value;
  if (!otherId || !relType) {
    toast('Please select a person and relationship type', 'error');
    return;
  }
  if (!_quickLinkPersonId) return;

  const btn = document.getElementById('ql-link-btn');
  btn.disabled = true;
  btn.textContent = 'Linking…';

  try {
    // Reuse the same batch-write logic as handleAddRelationship
    const p1Id = _quickLinkPersonId;
    const p2Id = otherId;
    const type = relType;

    const symmetric = ['sibling', 'spouse'];
    const isSymmetric = symmetric.includes(type);
    const inverseMap = { parent: 'child', child: 'parent' };
    const inverseType = isSymmetric ? type : inverseMap[type];

    const batch = db.batch();
    const relCol = db.collection('relationships');

    const fwdRef = relCol.doc();
    batch.set(fwdRef, {
      person1Id: p1Id, person2Id: p2Id,
      relationshipType: type,
      isReverse: false,
      createdBy: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    if (!isSymmetric) {
      const revRef = relCol.doc();
      batch.set(revRef, {
        person1Id: p2Id, person2Id: p1Id,
        relationshipType: inverseType,
        isReverse: true,
        createdBy: currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();
    toast('Relationship linked! ✓', 'success');
    const p1n = nodeById.get(p1Id)?.name || p1Id;
    const p2n = nodeById.get(p2Id)?.name || p2Id;
    logActivity('add_relationship', { person1Id: p1Id, person1Name: p1n, person2Id: p2Id, person2Name: p2n, relationshipType: type, source: 'quick-link' });
    closeQuickLinkModal();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Link';
  }
}

async function handleAddRelationship(e) {
  e.preventDefault();
  const p1Id  = document.getElementById('rel-p1').value;
  const type  = document.getElementById('rel-type').value;
  const p2Id  = document.getElementById('rel-p2').value;

  if (!p1Id || !type || !p2Id) return;
  if (p1Id === p2Id) return toast('Cannot link a person to themselves.', 'error');

  // Prevent duplicate edges (check both directions)
  const dup = graphData.links.find(l =>
    (l.person1Id === p1Id && l.person2Id === p2Id) ||
    (l.person1Id === p2Id && l.person2Id === p1Id)
  );
  if (dup) return toast('A relationship already exists between these two people.', 'error');

  // Conflict detection: would this create a logical impossibility?
  const conflict = detectConflict(p1Id, type, p2Id);

  const inverseType = getInverse(type);
  const batch = db.batch();

  const fwdRef = db.collection('relationships').doc();
  batch.set(fwdRef, {
    person1Id:        p1Id,
    person2Id:        p2Id,
    relationshipType: type,
    createdBy:        currentUser.uid,
    createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
    isReverse:        false,
    conflicted:       conflict
  });

  // For asymmetric relationships, also store the reverse so queries are simpler
  if (type !== inverseType) {
    const revRef = db.collection('relationships').doc();
    batch.set(revRef, {
      person1Id:        p2Id,
      person2Id:        p1Id,
      relationshipType: inverseType,
      createdBy:        currentUser.uid,
      createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
      isReverse:        true,
      conflicted:       conflict
    });
  }

  try {
    await batch.commit();
    document.getElementById('form-add-rel').reset();
    toast(conflict ? '⚠️ Relationship added (conflict flagged).' : 'Relationship added!', conflict ? '' : 'success');
    const p1n = nodeById.get(p1Id)?.name || p1Id;
    const p2n = nodeById.get(p2Id)?.name || p2Id;
    logActivity('add_relationship', { person1Id: p1Id, person1Name: p1n, person2Id: p2Id, person2Name: p2n, relationshipType: type, conflicted: conflict });
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

/**
 * Detect logical conflicts.
 * Currently checks:
 *  - Parent-of-a-parent-of-self (circular ancestry)
 *  - Person already has 2+ parents when adding another parent relationship
 */
function detectConflict(p1Id, type, p2Id) {
  // Check circular ancestry: if p2 is already an ancestor of p1 and we're making p1 parent of p2
  if (type === 'parent') {
    if (isAncestor(p1Id, p2Id)) return true; // p2 is already a descendant of p1 → cycle

    // Also flag if p2 already has 2 parents
    const existingParents = graphData.links.filter(l => l.person2Id === p2Id && l.relationshipType === 'parent');
    if (existingParents.length >= 2) return true;
  }
  if (type === 'child') {
    // p1 becomes child of p2 → check if p1 already has 2 parents
    const existingParents = graphData.links.filter(l => l.person2Id === p1Id && l.relationshipType === 'parent');
    if (existingParents.length >= 2) return true;
    if (isAncestor(p2Id, p1Id)) return true;
  }
  return false;
}

/**
 * isAncestor(ancestorId, descendantId)
 * Returns true if ancestorId appears in the ancestor chain of descendantId.
 * Uses BFS traversal of parent links.
 */
function isAncestor(ancestorId, descendantId) {
  const queue   = [descendantId];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === ancestorId) return true;
    // Find parents of current
    graphData.links
      .filter(l => l.person2Id === current && l.relationshipType === 'parent')
      .forEach(l => queue.push(l.person1Id));
  }
  return false;
}

function getInverse(type) {
  return {
    parent: 'child', child: 'parent',
    sibling: 'sibling', spouse: 'spouse',
    'parent-in-law': 'child-in-law',
    'child-in-law':  'parent-in-law',
    'sibling-in-law':'sibling-in-law'
  }[type] || type;
}

/**
 * Returns a gender-specific display label for in-law relationship types.
 * selfId = the person whose perspective we are showing (determines gender).
 * For standard types the label is returned unchanged.
 */
function getDisplayType(relType, selfId) {
  const gender = nodeById.get(selfId)?.gender || 'other';
  switch (relType) {
    case 'parent-in-law':
      return gender === 'male' ? 'father-in-law' : gender === 'female' ? 'mother-in-law' : 'parent-in-law';
    case 'child-in-law':
      return gender === 'male' ? 'son-in-law' : gender === 'female' ? 'daughter-in-law' : 'child-in-law';
    case 'sibling-in-law':
      return gender === 'male' ? 'brother-in-law' : gender === 'female' ? 'sister-in-law' : 'sibling-in-law';
    default:
      return relType;
  }
}

/* ════════════════════════════════════════════════════════════
   6. D3 GRAPH – INITIALISE
════════════════════════════════════════════════════════════ */

function initGraph() {
  svgEl  = document.getElementById('chart-svg');
  svgSel = d3.select(svgEl);

  // ── Zoom behaviour ──────────────────────────────────────
  zoomBehaviour = d3.zoom()
    .scaleExtent([0.04, 6])
    .on('zoom', (event) => {
      rootGroup.attr('transform', event.transform);
    });

  svgSel.call(zoomBehaviour);

  // Prevent double-click zoom (we use double-click for nodes)
  svgSel.on('dblclick.zoom', null);

  // Deselect node/link on background click; also cancel pick mode.
  // On mobile we never auto-close on SVG tap — ghost clicks from D3 drag make it
  // impossible to distinguish a real background tap from a node tap aftermath.
  // Mobile users close the info panel with the ✕ button instead.
  svgSel.on('click', (event) => {
    if (pickMode) { exitPickMode(); return; }
    if (window.innerWidth <= 768) return;          // mobile: ignore SVG background taps
    if (_nodeTapped) return;
    if (event.target && event.target.closest && event.target.closest('.node-g')) return;
    deselectNode();
    deselectLink();
  });

  // ── SVG layer groups ────────────────────────────────────
  rootGroup  = svgSel.select('#chart-root');
  linksLayer = svgSel.select('#links-layer');
  nodesLayer = svgSel.select('#nodes-layer');

  // ── Force simulation ────────────────────────────────────
  simulation = d3.forceSimulation()
    .force('link',    d3.forceLink().id(d => d.id).distance(180).strength(0.6))
    .force('charge',  d3.forceManyBody().strength(-600).distanceMax(800))
    .force('collide', d3.forceCollide(80))
    .force('centerX', d3.forceX(0).strength(0.03))
    .force('centerY', d3.forceY(0).strength(0.03))
    .alphaDecay(0.025)
    .velocityDecay(0.45)
    .on('tick', onSimulationTick);
}

/* ════════════════════════════════════════════════════════════
   6b. D3 GRAPH – FULL RENDER / UPDATE
   Called every time Firestore snapshot fires.
════════════════════════════════════════════════════════════ */

/** Returns true if a link should be visually hidden based on the current filter. */
function isLinkTypeHidden(relType) {
  if (!relType) return false;
  if (hiddenLinkTypes.has('in-law')  && relType.endsWith('-in-law'))                   return true;
  if (hiddenLinkTypes.has('parent')  && (relType === 'parent' || relType === 'child')) return true;
  if (hiddenLinkTypes.has('sibling') && relType === 'sibling')                         return true;
  if (hiddenLinkTypes.has('spouse')  && relType === 'spouse')                          return true;
  return false;
}

/** Toggle visibility of a link-type category and refresh the chart display. */
function toggleLinkType(type) {
  if (hiddenLinkTypes.has(type)) hiddenLinkTypes.delete(type);
  else hiddenLinkTypes.add(type);

  // Update button states in the legend
  document.querySelectorAll('.leg-toggle').forEach(btn => {
    btn.classList.toggle('leg-toggle-off', hiddenLinkTypes.has(btn.dataset.type));
  });

  // Apply/remove hidden class instantly — no simulation restart needed
  if (linksLayer) {
    linksLayer.selectAll('.link-g')
      .classed('link-type-hidden', d => isLinkTypeHidden(d.relationshipType));
  }
}

function updateGraph() {
  if (!svgSel) return;

  const hasNodes = graphData.nodes.length > 0;
  document.getElementById('empty-state').style.display = hasNodes ? 'none' : 'block';

  // Only render visible (non-reverse) links to avoid duplicate edges
  const visibleLinks = graphData.links.filter(l => !l.isReverse);

  // ── Rebuild nodeById ────────────────────────────────────
  nodeById = new Map(graphData.nodes.map(n => [n.id, n]));

  // ── LINKS ───────────────────────────────────────────────
  const linkSel = linksLayer.selectAll('.link-g')
    .data(visibleLinks, d => d.id);

  // Remove deleted links
  linkSel.exit().remove();

  // Enter new links
  const linkEnter = linkSel.enter()
    .append('g')
    .attr('class', 'link-g')
    .on('click', (event, d) => {
      event.stopPropagation();
      deselectNode();          // close node info panel first
      selectLink(d.id, event);
    });

  // Invisible wide hit-area so thin curves are easy to click
  linkEnter.append('path')
    .attr('class', 'link-hitarea')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 22)
    .attr('fill', 'none')
    .style('cursor', 'pointer');

  linkEnter.append('path').attr('class', 'link-line');
  linkEnter.append('text').attr('class', 'link-label');

  // Update all links (enter + existing)
  const linkMerge = linkEnter.merge(linkSel);
  linkMerge.select('.link-line')
    .attr('class', d => {
      const base = d.relationshipType.endsWith('-in-law') ? 'in-law' : d.relationshipType;
      return `link-line ${base}-type${d.conflicted ? ' conflicted' : ''}`;
    })
    .attr('stroke', d => d.conflicted ? '#f59e0b' : LINK_COLORS[d.relationshipType] || '#94a3b8')
    .attr('fill', 'none');

  linkMerge.select('.link-label')
    .text(d => getDisplayType(d.relationshipType, d.person1Id));

  // Restore selection highlight
  linkMerge.classed('link-selected', d => d.id === selectedLinkId);

  // Apply visibility filter
  linkMerge.classed('link-type-hidden', d => isLinkTypeHidden(d.relationshipType));

  // ── NODES ───────────────────────────────────────────────
  const nodeSel = nodesLayer.selectAll('.node-g')
    .data(graphData.nodes, d => d.id);

  // Remove deleted nodes
  nodeSel.exit().remove();

  // Enter new nodes
  const nodeEnter = nodeSel.enter()
    .append('g')
    .attr('class', 'node-g')
    .call(
      d3.drag()
        .on('start', onDragStart)
        .on('drag',  onDrag)
        .on('end',   onDragEnd)
    )
    .on('touchstart', (event, d) => {
      // Set guard immediately on touch so the 300ms ghost click can't close the panel
      event.stopPropagation();
      _nodeTapped = true;
      clearTimeout(_nodeTapTimer);
      _nodeTapTimer = setTimeout(() => { _nodeTapped = false; }, 600);
      selectNode(d.id);
    }, { passive: false })
    .on('click', (event, d) => {
      event.stopPropagation();
      _nodeTapped = true;
      clearTimeout(_nodeTapTimer);
      _nodeTapTimer = setTimeout(() => { _nodeTapped = false; }, 600);
      selectNode(d.id);
    });

  // Shadow (slightly offset rect for depth effect)
  nodeEnter.append('rect')
    .attr('class', 'node-shadow')
    .attr('x',      -NODE_W / 2 + 3)
    .attr('y',      -NODE_H / 2 + 4)
    .attr('width',  NODE_W)
    .attr('height', NODE_H)
    .attr('rx',     NODE_RX)
    .attr('ry',     NODE_RX)
    .attr('fill',   'rgba(0,0,0,.18)');

  // Main rect
  nodeEnter.append('rect')
    .attr('class', 'node-rect')
    .attr('x',      -NODE_W / 2)
    .attr('y',      -NODE_H / 2)
    .attr('width',  NODE_W)
    .attr('height', NODE_H)
    .attr('rx',     NODE_RX)
    .attr('ry',     NODE_RX);

  // Gender icon (top-left corner, clearly above the name row)
  nodeEnter.append('text')
    .attr('class', 'node-gender-icon')
    .attr('x', -NODE_W / 2 + 12)
    .attr('y', -NODE_H / 2 + 13)
    .attr('dominant-baseline', 'middle');

  // Name (centre, shifted down so it doesn't overlap the icon)
  nodeEnter.append('text')
    .attr('class', 'node-name-text')
    .attr('text-anchor', 'middle')
    .attr('y', 4);

  // Birth year (below name)
  nodeEnter.append('text')
    .attr('class', 'node-year-text')
    .attr('text-anchor', 'middle')
    .attr('y', 20);

  // Verified tick (top-right)
  nodeEnter.append('text')
    .attr('class', 'verified-tick')
    .attr('x', NODE_W / 2 - 8)
    .attr('y', -NODE_H / 2 + 16)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle');

  // ── Update all nodes (enter + existing) ─────────────────
  const nodeMerge = nodeEnter.merge(nodeSel);

  nodeMerge.select('.node-rect')
    .attr('fill', d => GENDER_COLORS[d.gender] || GENDER_COLORS.other);

  nodeMerge.select('.node-gender-icon')
    .text(d => d.gender === 'male' ? '♂' : d.gender === 'female' ? '♀' : '⚧');

  nodeMerge.select('.node-name-text')
    .text(d => abbreviate(d.name, 13));

  nodeMerge.select('.node-year-text')
    .text(d => d.dateOfBirth ? extractYear(d.dateOfBirth) : '');

  nodeMerge.select('.verified-tick')
    .text(d => d.isVerified ? '✓' : '');

  // Restore selection highlight
  nodeMerge.classed('selected', d => d.id === selectedNodeId);

  // ── Feed simulation ─────────────────────────────────────
  // Build sim-links with source/target as IDs (D3 will resolve)
  const simLinks = visibleLinks.map(l => ({
    id:               l.id,
    source:           l.person1Id,
    target:           l.person2Id,
    relationshipType: l.relationshipType
  }));

  simulation.nodes(graphData.nodes);
  simulation.force('link').links(simLinks);
  simulation.force('hierarchy', buildHierarchyForce()); // custom Y force
  simulation.alpha(0.25).restart();

  // Auto-fit view on very first render
  if (!graphInitialised && hasNodes) {
    graphInitialised = true;
    setTimeout(fitView, 800); // wait for simulation to settle a bit
  }
}

/* ════════════════════════════════════════════════════════════
   7. D3 GRAPH – SIMULATION TICK
════════════════════════════════════════════════════════════ */

function onSimulationTick() {
  // ── Update link positions (bezier curves) ───────────────
  linksLayer.selectAll('.link-g').each(function(d) {
    const src = nodeById.get(d.person1Id);
    const tgt = nodeById.get(d.person2Id);
    if (!src || !tgt) return;

    const pathD = computeLinkPath(src, tgt, d.relationshipType);
    d3.select(this).select('.link-hitarea').attr('d', pathD);
    d3.select(this).select('.link-line').attr('d', pathD);

    // Place label at the midpoint of the curve
    const mx = (src.x + tgt.x) / 2;
    const my = (src.y + tgt.y) / 2;
    d3.select(this).select('.link-label')
      .attr('x', mx)
      .attr('y', my - 8);
  });

  // ── Update node positions ────────────────────────────────
  nodesLayer.selectAll('.node-g')
    .attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);
}

/**
 * computeLinkPath – returns an SVG path `d` string for a curved link.
 *
 * Curve shapes by relationship type:
 *  parent / child → cubic S-curve following the vertical hierarchy
 *  spouse         → arc bowing upward between partners at the same level
 *  sibling        → arc bowing downward between siblings at the same level
 *
 * Endpoints are offset to the node rectangle border so lines don't
 * disappear under the filled rect.
 */
function computeLinkPath(src, tgt, type) {
  const dx   = tgt.x - src.x;
  const dy   = tgt.y - src.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  // Clamp start/end to the node border (rect edge), not the centre
  const hw = NODE_W / 2 + 2;
  const hh = NODE_H / 2 + 2;
  const sx  = src.x + Math.sign(dx) * Math.min(hw, Math.abs(dx) / dist * hw);
  const sy  = src.y + Math.sign(dy) * Math.min(hh, Math.abs(dy) / dist * hh);
  const tx  = tgt.x - Math.sign(dx) * Math.min(hw, Math.abs(dx) / dist * hw);
  const ty  = tgt.y - Math.sign(dy) * Math.min(hh, Math.abs(dy) / dist * hh);

  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;

  if (type === 'parent' || type === 'child') {
    // Cubic bezier – control points directly above src and below tgt
    // This creates a smooth elbow following the vertical hierarchy
    return `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`;
  }

  if (type === 'spouse') {
    // Quadratic arc bowing upward (spouses typically sit side-by-side)
    const bow = Math.min(dist * 0.25, 55);
    return `M${sx},${sy} Q${mx},${my - bow} ${tx},${ty}`;
  }

  if (type === 'sibling') {
    // Quadratic arc bowing downward
    const bow = Math.min(dist * 0.22, 45);
    return `M${sx},${sy} Q${mx},${my + bow} ${tx},${ty}`;
  }

  // Fallback: straight line
  return `M${sx},${sy} L${tx},${ty}`;
}

/* ════════════════════════════════════════════════════════════
   7b. HIERARCHICAL LAYOUT FORCE
   Nudges nodes so that parents sit above their children,
   giving the chart a natural pedigree / family-tree feel.
════════════════════════════════════════════════════════════ */

function buildHierarchyForce() {
  // Assign generation levels via BFS from roots
  const childrenOf = new Map();  // parentId -> [childId]
  const parentsOf  = new Map();  // childId  -> [parentId]

  graphData.links.forEach(l => {
    if (l.relationshipType === 'parent') {
      if (!childrenOf.has(l.person1Id)) childrenOf.set(l.person1Id, []);
      childrenOf.get(l.person1Id).push(l.person2Id);

      if (!parentsOf.has(l.person2Id)) parentsOf.set(l.person2Id, []);
      parentsOf.get(l.person2Id).push(l.person1Id);
    }
  });

  const levels = new Map();

  // Iterative level assignment (handles disconnected components)
  function assignFrom(startId, startLevel) {
    const q = [{ id: startId, level: startLevel }];
    while (q.length) {
      const { id, level } = q.shift();
      if ((levels.get(id) ?? Infinity) <= level) continue;
      levels.set(id, level);
      (childrenOf.get(id) || []).forEach(cid => q.push({ id: cid, level: level + 1 }));
    }
  }

  // Start from nodes that have no parents (roots)
  graphData.nodes.forEach(n => {
    if (!parentsOf.has(n.id) || parentsOf.get(n.id).length === 0) {
      assignFrom(n.id, 0);
    }
  });
  // Also start from any still-unassigned node (disconnected sub-graph)
  graphData.nodes.forEach(n => {
    if (!levels.has(n.id)) assignFrom(n.id, 0);
  });

  const LEVEL_GAP = 160; // vertical spacing between generations

  // Return the custom force function
  return function(alpha) {
    graphData.nodes.forEach(node => {
      const level = levels.get(node.id) ?? 0;
      const targetY = level * LEVEL_GAP;
      // Gently nudge node toward its generation row
      node.vy += (targetY - node.y) * 0.12 * alpha;
    });
  };
}

/* ════════════════════════════════════════════════════════════
   8. DRAG HANDLERS
════════════════════════════════════════════════════════════ */

function onDragStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  // Fix the node in place while dragging
  d.fx = d.x;
  d.fy = d.y;
}

function onDrag(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function onDragEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  // Keep node pinned where user dropped it (comment out to let it float free again)
  // d.fx = null;
  // d.fy = null;
}

/* ════════════════════════════════════════════════════════════
   9. ZOOM / PAN CONTROLS
════════════════════════════════════════════════════════════ */

function zoomIn()   { svgSel.transition().duration(300).call(zoomBehaviour.scaleBy, 1.5); }
function zoomOut()  { svgSel.transition().duration(300).call(zoomBehaviour.scaleBy, 0.67); }
function resetZoom(){ svgSel.transition().duration(400).call(zoomBehaviour.transform, d3.zoomIdentity); }

/* ════════════════════════════════════════════════════════════
   9b. REARRANGE – Sugiyama crossing-minimisation layout
   ─ Y axis : strict BFS generation rows (parents always above children)
   ─ X axis : Sugiyama barycenter sweep (24 alternating top-down /
              bottom-up passes) – the standard algorithm for minimising
              line crossings in hierarchical graphs
   ─ Couples kept adjacent after every sort pass
   ─ Final X positions handed to the live simulation so nodes
     remain draggable and spring back to their row
════════════════════════════════════════════════════════════ */

function rearrangeChart() {
  const nodes = graphData.nodes;
  const links = graphData.links;
  if (!nodes.length) { toast('Nothing to rearrange', 'error'); return; }

  const btn = document.getElementById('rearrange-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Laying out…'; }

  const HGAP  = 120;   // horizontal px per node slot
  const VGAP  = 200;   // vertical px between generation rows
  const SWEEPS = 24;   // barycenter sweep iterations (more = fewer crossings)

  // ── 1. Build relationship maps (non-reverse links only) ────
  const childrenOf = new Map(nodes.map(n => [n.id, new Set()]));
  const parentsOf  = new Map(nodes.map(n => [n.id, new Set()]));
  const spousesOf  = new Map(nodes.map(n => [n.id, new Set()]));

  links.filter(l => !l.isReverse).forEach(({ person1Id: a, person2Id: b, relationshipType: t }) => {
    if      (t === 'parent') { childrenOf.get(a)?.add(b); parentsOf.get(b)?.add(a); }
    else if (t === 'child')  { childrenOf.get(b)?.add(a); parentsOf.get(a)?.add(b); }
    else if (t === 'spouse') { spousesOf.get(a)?.add(b);  spousesOf.get(b)?.add(a); }
  });

  // ── 2. BFS generation levels ───────────────────────────────
  const level = new Map();

  function bfsLevel(startId, startLv) {
    const q = [{ id: startId, lv: startLv }];
    while (q.length) {
      const { id, lv } = q.shift();
      if (level.has(id) && level.get(id) <= lv) continue;
      level.set(id, lv);
      childrenOf.get(id)?.forEach(c => q.push({ id: c, lv: lv + 1 }));
    }
  }
  nodes.forEach(n => { if (!parentsOf.get(n.id)?.size) bfsLevel(n.id, 0); });
  nodes.forEach(n => { if (!level.has(n.id)) bfsLevel(n.id, 0); });

  // Snap married-in nodes (no parents) to spouse's generation
  let snapDone = false;
  while (!snapDone) {
    snapDone = true;
    nodes.forEach(n => {
      if (parentsOf.get(n.id)?.size) return;
      spousesOf.get(n.id)?.forEach(sid => {
        const sl = level.get(sid);
        if (sl !== undefined && level.get(n.id) !== sl) {
          level.set(n.id, sl); snapDone = false;
        }
      });
    });
  }
  const minLv = Math.min(...level.values());
  nodes.forEach(n => level.set(n.id, level.get(n.id) - minLv));

  // ── 3. Group nodes by level ────────────────────────────────
  const byLevel = new Map();
  nodes.forEach(n => {
    const lv = level.get(n.id) ?? 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(n.id);
  });
  const levels = [...byLevel.keys()].sort((a, b) => a - b);

  // ── 4. Helper: keep couples adjacent inside an ordered list ─
  function coupleAdjacent(ids) {
    const result = [], placed = new Set();
    ids.forEach(id => {
      if (placed.has(id)) return;
      result.push(id); placed.add(id);
      spousesOf.get(id)?.forEach(sid => {
        if (!placed.has(sid) && ids.includes(sid)) {
          result.push(sid); placed.add(sid);
        }
      });
    });
    return result;
  }

  // ── 5. Initialise per-node "slot" positions (integer index) ─
  // Start with couples adjacent; positions will be refined by sweeps.
  const slot = new Map();   // id → float position used for barycenter math
  levels.forEach(lv => {
    const ordered = coupleAdjacent(byLevel.get(lv) || []);
    byLevel.set(lv, ordered);
    ordered.forEach((id, i) => slot.set(id, i));
  });

  // ── 6. Barycenter crossing-minimisation sweeps ─────────────
  // Each sweep: reorder a layer by the mean slot-position of its
  // neighbours in the adjacent layer, then re-apply couple-adjacency.
  // Alternating top-down / bottom-up propagates information both ways.

  function baryOf(id, refSlot) {
    // Neighbours that contribute to crossing count: parents & children
    const upNb   = [...(parentsOf.get(id)  || [])].filter(p => refSlot.has(p));
    const downNb = [...(childrenOf.get(id) || [])].filter(c => refSlot.has(c));
    const nb     = upNb.length ? upNb : downNb;
    if (!nb.length) return slot.get(id) ?? 0;   // unmoved
    return nb.reduce((sum, x) => sum + refSlot.get(x), 0) / nb.length;
  }

  for (let sw = 0; sw < SWEEPS; sw++) {
    if (sw % 2 === 0) {
      // Top-down pass
      for (let li = 1; li < levels.length; li++) {
        const lv  = levels[li];
        const ids = [...(byLevel.get(lv) || [])];
        const snap = new Map(ids.map(id => [id, slot.get(id) ?? 0]));  // snapshot of parent slots
        ids.sort((a, b) => baryOf(a, snap) - baryOf(b, snap));
        const reordered = coupleAdjacent(ids);
        byLevel.set(lv, reordered);
        reordered.forEach((id, i) => slot.set(id, i));
      }
    } else {
      // Bottom-up pass
      for (let li = levels.length - 2; li >= 0; li--) {
        const lv  = levels[li];
        const ids = [...(byLevel.get(lv) || [])];
        const snap = new Map(ids.map(id => [id, slot.get(id) ?? 0]));
        ids.sort((a, b) => baryOf(a, snap) - baryOf(b, snap));
        const reordered = coupleAdjacent(ids);
        byLevel.set(lv, reordered);
        reordered.forEach((id, i) => slot.set(id, i));
      }
    }
  }

  // ── 7. Convert slot indices → pixel X, set node positions ──
  levels.forEach(lv => {
    const ordered = byLevel.get(lv) || [];
    const n = ordered.length;
    ordered.forEach((id, i) => {
      const node = nodes.find(nd => nd.id === id);
      if (!node) return;
      node.x    = (i - (n - 1) / 2) * HGAP;
      node.y    = lv * VGAP;
      node._gen = lv;          // store for ongoing springback force
      node.fx   = null;        // keep nodes draggable
      node.fy   = null;
      node.vx   = 0;
      node.vy   = 0;
    });
  });

  // ── 8. Live simulation: genY springback + collision/charge ──
  // forceY keeps each node attracted to its generation row so nodes
  // spring back after being pushed; charge + collide prevent overlap.
  simulation
    .force('genY', d3.forceY(d => (d._gen ?? 0) * VGAP).strength(0.6))
    .alpha(0.4)
    .restart();

  setTimeout(() => {
    fitView();
    if (btn) { btn.disabled = false; btn.innerHTML = '⇄ Rearrange'; }
  }, 400);

  toast('Chart arranged – crossings minimised ✨');
}


/** Fit all nodes into the visible viewport with padding. */
function fitView() {
  if (!graphData.nodes.length) return;

  const svgW = svgEl.clientWidth  || 800;
  const svgH = svgEl.clientHeight || 600;
  const pad  = 80;

  const xs = graphData.nodes.map(n => n.x || 0);
  const ys = graphData.nodes.map(n => n.y || 0);
  const minX = Math.min(...xs) - NODE_W / 2;
  const maxX = Math.max(...xs) + NODE_W / 2;
  const minY = Math.min(...ys) - NODE_H / 2;
  const maxY = Math.max(...ys) + NODE_H / 2;

  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  const scale = Math.min((svgW - pad * 2) / dataW, (svgH - pad * 2) / dataH, 2);
  const tx    = svgW / 2 - scale * (minX + dataW / 2);
  const ty    = svgH / 2 - scale * (minY + dataH / 2);

  svgSel.transition().duration(600)
    .call(zoomBehaviour.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

/** Pan & zoom to centre the given node in the viewport. */
function centreOnNode(nodeId) {
  const node = nodeById.get(nodeId);
  if (!node) return;
  const svgW = svgEl.clientWidth  || 800;
  const svgH = svgEl.clientHeight || 600;
  svgSel.transition().duration(500)
    .call(zoomBehaviour.transform,
      d3.zoomIdentity.translate(svgW / 2 - node.x, svgH / 2 - node.y).scale(1));
}

/* ════════════════════════════════════════════════════════════
   10. NODE SELECTION & DETAIL MODAL
════════════════════════════════════════════════════════════ */

/** Returns the Set of node IDs directly connected to the given node. */
function getConnectedIds(nodeId) {
  const ids = new Set();
  graphData.links.forEach(l => {
    if (l.person1Id === nodeId) ids.add(l.person2Id);
    if (l.person2Id === nodeId) ids.add(l.person1Id);
  });
  return ids;
}

function selectNode(id) {
  // ── Pick-mode: fill the waiting field instead of opening info panel ──
  if (pickMode) {
    const { field } = pickMode;
    ppSetById(field, id);
    const name = nodeById.get(id)?.name || 'Person';
    exitPickMode();
    toast(`${name} selected`, 'success');
    if (field === 'trace-p1' || field === 'trace-p2') {
      const p1 = document.getElementById('trace-p1')?.value;
      const p2 = document.getElementById('trace-p2')?.value;
      if (p1 && p2) runTrace();
    }
    return;
  }

  selectedNodeId = id;
  const connectedIds = getConnectedIds(id);
  const hasConnections = connectedIds.size > 0;

  // ── Highlight selected node, dim or tag connected ones ──
  nodesLayer.selectAll('.node-g')
    .classed('selected',  d => d.id === id)
    .classed('connected', d => connectedIds.has(d.id))
    .classed('faded',     d => hasConnections && d.id !== id && !connectedIds.has(d.id));

  // ── Highlight edges that touch the selected node ─────────
  linksLayer.selectAll('.link-g')
    .classed('link-active', d => d.person1Id === id || d.person2Id === id)
    .classed('link-faded',  d => d.person1Id !== id && d.person2Id !== id && hasConnections);

  showInfoPanel(id);
}

function deselectNode() {
  // On mobile: if the panel was shown within the last 800ms, ignore stray close calls
  if (window.innerWidth <= 768 && (Date.now() - _infoPanelShownAt) < 800) return;
  selectedNodeId = null;
  nodesLayer.selectAll('.node-g').classed('selected connected faded', false);
  linksLayer.selectAll('.link-g').classed('link-active link-faded', false);
  document.getElementById('info-panel').style.display = 'none';
  // Restore trace highlight if one is active
  if (activeTracePath !== null) {
    const p1Id = document.getElementById('trace-p1').value;
    const p2Id = document.getElementById('trace-p2').value;
    applyTraceHighlight(activeTracePath, p1Id, p2Id);
  }
}

/* ────────────────────────────────────────────────────────────
   LINK (EDGE) SELECTION & REMOVAL
──────────────────────────────────────────────────────────── */

function selectLink(linkId, event) {
  // Deselect previous
  if (selectedLinkId) deselectLink(false);
  selectedLinkId = linkId;

  linksLayer.selectAll('.link-g').classed('link-selected', d => d.id === linkId);

  const link = graphData.links.find(l => l.id === linkId);
  if (!link) return;

  const p1 = nodeById.get(link.person1Id);
  const p2 = nodeById.get(link.person2Id);
  const color = LINK_COLORS[link.relationshipType] || '#94a3b8';

  // Populate popover
  document.getElementById('lp-person1').textContent    = p1?.name || '?';
  document.getElementById('lp-rel-badge').textContent  = link.relationshipType;
  document.getElementById('lp-rel-badge').style.color  = color;
  document.getElementById('lp-rel-badge').style.borderColor = color;
  document.getElementById('lp-person2').textContent    = p2?.name || '?';

  const canDelete = currentProfile.role === 'admin' || link.createdBy === currentUser.uid;
  document.getElementById('lp-delete-btn').style.display = canDelete ? 'inline-flex' : 'none';

  // Position the popover at the curve midpoint in screen coordinates
  const src = nodeById.get(link.person1Id);
  const tgt = nodeById.get(link.person2Id);
  const popover  = document.getElementById('link-popover');
  const chartDiv = document.querySelector('.chart-area');

  if (src && tgt && chartDiv) {
    const transform = d3.zoomTransform(svgEl);
    const mx = (src.x + tgt.x) / 2;
    const my = (src.y + tgt.y) / 2;
    const chartRect = chartDiv.getBoundingClientRect();
    const sx = transform.applyX(mx);
    const sy = transform.applyY(my);

    // Keep popover inside chart bounds
    const pw = 220, ph = 90;
    const left = Math.min(Math.max(sx - pw / 2, 8), chartRect.width  - pw - 8);
    const top  = Math.min(Math.max(sy - ph - 16, 8), chartRect.height - ph - 8);

    popover.style.left = left + 'px';
    popover.style.top  = top  + 'px';
  }

  popover.style.display = 'flex';
}

function deselectLink(clearState = true) {
  if (clearState) selectedLinkId = null;
  linksLayer.selectAll('.link-g').classed('link-selected', false);
  document.getElementById('link-popover').style.display = 'none';
}

async function deleteSelectedLink() {
  if (!selectedLinkId) return;
  const link = graphData.links.find(l => l.id === selectedLinkId);
  if (!link) return;

  const isOwner = link.createdBy === currentUser.uid;
  const isAdmin = currentProfile.role === 'admin';
  if (!isOwner && !isAdmin) { toast('You can only remove relationships you created.', 'error'); return; }

  const p1 = nodeById.get(link.person1Id);
  const p2 = nodeById.get(link.person2Id);
  if (!confirm(`Remove the "${link.relationshipType}" relationship between ${p1?.name || '?'} and ${p2?.name || '?'}?`)) return;

  try {
    const batch = db.batch();
    batch.delete(db.collection('relationships').doc(selectedLinkId));

    // Also delete the paired reverse link if it exists
    const reverse = graphData.links.find(l =>
      l.isReverse &&
      l.person1Id === link.person2Id &&
      l.person2Id === link.person1Id
    );
    if (reverse) batch.delete(db.collection('relationships').doc(reverse.id));

    await batch.commit();
    logActivity('delete_relationship', {
      person1Id: link.person1Id, person1Name: p1?.name || link.person1Id,
      person2Id: link.person2Id, person2Name: p2?.name || link.person2Id,
      relationshipType: link.relationshipType
    });
    deselectLink();
    toast('Relationship removed.', 'success');
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

/** Show the floating info panel on the chart with node details + connections. */
function showInfoPanel(nodeId) {
  const node = nodeById.get(nodeId);
  if (!node) return;
  _infoPanelShownAt = Date.now(); // record when panel was shown (used by mobile ghost-click guard)

  // Header
  document.getElementById('ip-name').textContent   = node.name;
  document.getElementById('ip-avatar').textContent = node.gender === 'male' ? '♂' : node.gender === 'female' ? '♀' : '⚧';
  document.getElementById('ip-avatar').style.background = GENDER_COLORS[node.gender] || GENDER_COLORS.other;
  document.getElementById('ip-meta').textContent =
    (node.gender.charAt(0).toUpperCase() + node.gender.slice(1)) +
    (node.dateOfBirth ? ' · b. ' + extractYear(node.dateOfBirth) : '') +
    (node.isVerified  ? ' · ✓'  : '');

  // Connections list
  const rels = graphData.links.filter(l =>
    (l.person1Id === nodeId || l.person2Id === nodeId) && !l.isReverse
  );

  let connectionsHtml = '';
  if (rels.length === 0) {
    connectionsHtml = '<p class="ip-empty">No connections yet.</p>';
  } else {
    connectionsHtml = rels.map(rel => {
      const otherId    = rel.person1Id === nodeId ? rel.person2Id : rel.person1Id;
      const other      = nodeById.get(otherId);
      const dispType   = rel.person1Id === nodeId ? rel.relationshipType : getInverse(rel.relationshipType);
      const dispLabel  = getDisplayType(dispType, nodeId);
      const color      = LINK_COLORS[dispType] || '#94a3b8';
      const dotColor   = GENDER_COLORS[other?.gender] || '#94a3b8';
      const conflict   = rel.conflicted ? ' ⚠️' : '';
      return `<div class="ip-conn-item" onclick="selectNode('${otherId}')">
        <span class="ip-rel-dot" style="background:${color}"></span>
        <div class="ip-conn-body">
          <span class="ip-conn-name">${escapeHtml(other ? other.name : 'Unknown')}</span>
          <span class="ip-conn-type">${dispLabel}${conflict}</span>
        </div>
        <span class="ip-gender-dot" style="background:${dotColor}"></span>
      </div>`;
    }).join('');
  }

  document.getElementById('ip-connections').innerHTML =
    `<div class="ip-conn-header">${rels.length} Connection${rels.length !== 1 ? 's' : ''}</div>` +
    connectionsHtml;

  // Admin / owner actions
  const isOwner = node.createdBy === currentUser.uid;
  const isAdmin = currentProfile.role === 'admin';
  const canEdit   = isOwner || isAdmin;
  const canDelete = isOwner || isAdmin;
  document.getElementById('ip-actions').style.display    = canEdit   ? 'flex'        : 'none';
  document.getElementById('ip-btn-delete').style.display = canDelete ? 'inline-flex' : 'none';

  document.getElementById('info-panel').style.display = 'flex';
}

/** Called from info panel Edit button */
function ipEdit() {
  if (!selectedNodeId) return;
  const node = nodeById.get(selectedNodeId);
  if (!node) return;
  const isOwner = node.createdBy === currentUser.uid;
  const isAdmin = currentProfile.role === 'admin';
  if (!isOwner && !isAdmin) { toast('You can only edit people you added.', 'error'); return; }
  document.getElementById('edit-id').value     = node.id;
  document.getElementById('edit-name').value   = node.name;
  document.getElementById('edit-gender').value = node.gender;
  document.getElementById('edit-dob').value    = node.dateOfBirth || '';
  document.getElementById('modal-edit').style.display = 'flex';
}

/** Called from info panel Delete button */
function ipDelete() { deleteSelectedNode(); }

/** Enter pick mode: close the info panel and wait for the user to click a person on the chart. */
function enterPickMode(field, label) {
  pickMode = { field, label };
  deselectNode(); // close info panel so chart is fully visible
  svgEl.classList.add('pick-mode-active');
  const banner = document.getElementById('pick-banner');
  document.getElementById('pick-banner-label').textContent = `Click a person to set as ${label}`;
  banner.style.display = 'flex';
}

/** Cancel pick mode without selecting anyone. */
function exitPickMode() {
  pickMode = null;
  svgEl.classList.remove('pick-mode-active');
  document.getElementById('pick-banner').style.display = 'none';
}

function ipSetRelP1()   { enterPickMode('rel-p1',   'Person 1 in Add Relationship'); }
function ipSetRelP2()   { enterPickMode('rel-p2',   'Person 2 in Add Relationship'); }
function ipSetTraceP1() { enterPickMode('trace-p1', 'trace start'); }
function ipSetTraceP2() { enterPickMode('trace-p2', 'trace destination'); }

/** Kept for backward-compat (modal-node is still in HTML for admin edit/delete) */
function openNodeModal(nodeId) { showInfoPanel(nodeId); }

function openEditModal() { ipEdit(); }

async function handleEditSave(e) {
  e.preventDefault();
  const id     = document.getElementById('edit-id').value;
  const name   = document.getElementById('edit-name').value.trim();
  const gender = document.getElementById('edit-gender').value;
  const dob    = document.getElementById('edit-dob').value || null;

  if (!name) return;

  // Capture old values for the log before writing
  const _nodeSnap = nodeById.get(id);
  const _oldName   = _nodeSnap?.name        || '';
  const _oldGender = _nodeSnap?.gender      || '';
  const _oldDob    = _nodeSnap?.dateOfBirth || '';

  // Permission guard — re-check on the client before writing
  const node = nodeById.get(id);
  if (node) {
    const isOwner = node.createdBy === currentUser.uid;
    const isAdmin = currentProfile.role === 'admin';
    if (!isOwner && !isAdmin) {
      toast('You can only edit people you added.', 'error');
      closeModal('modal-edit');
      return;
    }
  }

  try {
    await db.collection('nodes').doc(id).update({
      name, gender,
      dateOfBirth: dob,
      updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy:   currentUser.uid
    });
    closeModal('modal-edit');
    toast('Changes saved!', 'success');
    logActivity('edit_person', {
      personId: id, personName: name,
      oldName: _oldName, newName: name,
      oldGender: _oldGender, newGender: gender,
      oldDob: _oldDob, newDob: dob || ''
    });
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function deleteSelectedNode() {
  if (!selectedNodeId) return;
  const node = nodeById.get(selectedNodeId);
  if (!node) return;

  const isOwner = node.createdBy === currentUser.uid;
  const isAdmin = currentProfile.role === 'admin';
  if (!isOwner && !isAdmin) { toast('You can only delete people you added.', 'error'); return; }

  if (!confirm(`Permanently delete "${node.name}" and all their relationships?`)) return;

  try {
    const batch = db.batch();
    batch.delete(db.collection('nodes').doc(selectedNodeId));

    // Delete all relationships that involve this node
    graphData.links
      .filter(l => l.person1Id === selectedNodeId || l.person2Id === selectedNodeId)
      .forEach(l => batch.delete(db.collection('relationships').doc(l.id)));

    await batch.commit();
    logActivity('delete_person', { personId: selectedNodeId, personName: node.name, gender: node.gender });
    closeModal('modal-node');
    deselectNode();
    toast(`"${node.name}" deleted.`);
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

/* ════════════════════════════════════════════════════════════
   10c. ACTIVITY LOG
════════════════════════════════════════════════════════════ */

/**
 * Fire-and-forget helper — writes one entry to the activityLogs collection.
 * Never blocks or throws; failures are silently warned in the console.
 *
 * @param {string} action   – e.g. 'add_person', 'edit_person', 'delete_person',
 *                            'add_relationship', 'delete_relationship', 'accept_suggestion'
 * @param {object} details  – arbitrary metadata about the action
 */
function logActivity(action, details = {}) {
  db.collection('activityLogs').add({
    action,
    userId:    currentUser.uid,
    userName:  currentProfile.displayName || currentProfile.name || currentUser.email,
    userEmail: currentUser.email,
    role:      currentProfile.role,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    details
  }).catch(err => console.warn('Activity log write failed:', err));
}

/** Open the Activity Log modal (admin only). */
async function openActivityLog() {
  if (currentProfile.role !== 'admin') return;
  document.getElementById('modal-activity-log').style.display = 'flex';
  const body = document.getElementById('activity-log-body');
  body.innerHTML = '<div class="al-loading">⏳ Loading activity…</div>';

  try {
    const snap = await db.collection('activityLogs')
      .orderBy('timestamp', 'desc')
      .limit(300)
      .get();

    if (snap.empty) {
      body.innerHTML = '<div class="al-empty"><span>📭</span><p>No activity recorded yet.</p></div>';
      return;
    }

    const ACTION_META = {
      add_person:          { icon: '➕', label: 'Added person',          color: '#22c55e' },
      edit_person:         { icon: '✏️', label: 'Edited person',          color: '#3b82f6' },
      delete_person:       { icon: '🗑', label: 'Deleted person',         color: '#ef4444' },
      add_relationship:    { icon: '🔗', label: 'Added relationship',     color: '#8b5cf6' },
      delete_relationship: { icon: '✂️', label: 'Removed relationship',   color: '#f59e0b' },
      accept_suggestion:   { icon: '💡', label: 'Accepted suggestion',    color: '#0d9488' },
    };

    body.innerHTML = snap.docs.map(doc => {
      const d  = doc.data();
      const ts = d.timestamp?.toDate ? d.timestamp.toDate() : null;
      const timeStr = ts
        ? ts.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : '—';

      const meta  = ACTION_META[d.action] || { icon: '•', label: d.action, color: '#64748b' };
      const isAdm = d.role === 'admin';

      // Build detail line
      const det = d.details || {};
      let detailParts = [];
      if (det.personName)     detailParts.push(`<strong>${escapeHtml(det.personName)}</strong>`);
      if (det.oldName && det.newName && det.oldName !== det.newName)
        detailParts.push(`<span class="al-change">${escapeHtml(det.oldName)} → ${escapeHtml(det.newName)}</span>`);
      if (det.person1Name)    detailParts.push(`<strong>${escapeHtml(det.person1Name)}</strong>`);
      if (det.relationshipType)
        detailParts.push(`<span class="al-rel-badge">${escapeHtml(det.relationshipType)}</span>`);
      if (det.person2Name)    detailParts.push(`<strong>${escapeHtml(det.person2Name)}</strong>`);
      if (det.oldGender && det.newGender && det.oldGender !== det.newGender)
        detailParts.push(`<span class="al-change">${escapeHtml(det.oldGender)} → ${escapeHtml(det.newGender)}</span>`);

      return `
        <div class="al-entry">
          <span class="al-icon" style="background:${meta.color}22;color:${meta.color}">${meta.icon}</span>
          <div class="al-entry-body">
            <div class="al-entry-top">
              <span class="al-action-label" style="color:${meta.color}">${meta.label}</span>
              ${detailParts.length ? '<span class="al-dot">·</span>' + detailParts.join(' ') : ''}
            </div>
            <div class="al-entry-bottom">
              <span class="al-user-name">${escapeHtml(det.userName || d.userName || d.userEmail)}</span>
              <span class="al-role-badge ${isAdm ? 'al-role-admin' : 'al-role-user'}">${d.role}</span>
              <span class="al-time">${timeStr}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<div style="color:var(--danger);padding:20px;text-align:center">${escapeHtml(err.message)}</div>`;
  }
}

/* ════════════════════════════════════════════════════════════
   11. ADMIN – USER MANAGEMENT
════════════════════════════════════════════════════════════ */

async function openUserMgmt() {
  if (currentProfile.role !== 'admin') return;
  try {
    const snap  = await db.collection('users').get();
    const users = snap.docs.map(d => d.data());

    let rows = users.map(u => {
      const statusBadge = u.approved
        ? `<span class="badge-approved">Approved</span>`
        : `<span class="badge-pending">Pending</span>`;
      const actions = [];
      if (!u.approved)           actions.push(`<button class="btn-xs" onclick="approveUser('${u.uid}')">Approve</button>`);
      if (u.approved)            actions.push(`<button class="btn-xs danger" onclick="blockUser('${u.uid}')">Block</button>`);
      if (u.role !== 'admin')    actions.push(`<button class="btn-xs" onclick="makeAdmin('${u.uid}')">Make Admin</button>`);
      if (u.uid === currentUser.uid) return `<tr><td>${u.name}</td><td>${u.email}</td><td>${u.role}</td><td>${statusBadge}</td><td><em style="font-size:12px;color:var(--text-muted)">You</em></td></tr>`;
      return `<tr><td>${u.name}</td><td>${u.email}</td><td>${u.role}</td><td>${statusBadge}</td><td><div class="tbl-actions">${actions.join('')}</div></td></tr>`;
    }).join('');

    document.getElementById('users-table-wrap').innerHTML = `
      <table class="users-tbl">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    document.getElementById('modal-users').style.display = 'flex';
  } catch (err) {
    toast('Error loading users: ' + err.message, 'error');
  }
}

async function approveUser(uid) {
  await db.collection('users').doc(uid).update({ approved: true });
  toast('User approved!', 'success');
  openUserMgmt();
}

async function blockUser(uid) {
  await db.collection('users').doc(uid).update({ approved: false });
  toast('User blocked.');
  openUserMgmt();
}

async function makeAdmin(uid) {
  if (!confirm('Grant admin role to this user?')) return;
  await db.collection('users').doc(uid).update({ role: 'admin', approved: true });
  toast('User promoted to admin.', 'success');
  openUserMgmt();
}

/* ════════════════════════════════════════════════════════════
   11b. ADMIN – CONFLICTS
════════════════════════════════════════════════════════════ */

function openConflicts() {
  const conflicts = graphData.links.filter(l => l.conflicted && !l.isReverse);

  if (conflicts.length === 0) {
    document.getElementById('conflicts-body').innerHTML =
      '<p style="color:var(--text-muted);font-size:14px;padding:8px 0">No conflicts detected 🎉</p>';
  } else {
    document.getElementById('conflicts-body').innerHTML = conflicts.map(rel => {
      const p1 = nodeById.get(rel.person1Id);
      const p2 = nodeById.get(rel.person2Id);
      return `<div class="conflict-card">
        <p>
          <strong>${p1 ? p1.name : rel.person1Id}</strong>
          is marked as <em>${rel.relationshipType}</em> of
          <strong>${p2 ? p2.name : rel.person2Id}</strong><br/>
          <span style="font-size:12px;color:var(--text-muted)">This relationship was flagged as potentially inconsistent.</span>
        </p>
        <div class="conflict-actions">
          <button class="btn-secondary" onclick="resolveConflict('${rel.id}')">✅ Mark as Resolved</button>
          <button class="btn-danger"    onclick="deleteRelationship('${rel.id}')">🗑 Delete Link</button>
        </div>
      </div>`;
    }).join('');
  }

  document.getElementById('modal-conflicts').style.display = 'flex';
}

async function resolveConflict(relId) {
  // Also clear the paired reverse relationship
  const rel     = graphData.links.find(l => l.id === relId);
  const revLink  = rel ? graphData.links.find(l =>
    l.isReverse && l.person1Id === rel.person2Id && l.person2Id === rel.person1Id
  ) : null;

  const batch = db.batch();
  batch.update(db.collection('relationships').doc(relId), { conflicted: false });
  if (revLink) batch.update(db.collection('relationships').doc(revLink.id), { conflicted: false });

  await batch.commit();
  toast('Conflict resolved.', 'success');
  openConflicts();
}

async function deleteRelationship(relId) {
  if (!confirm('Delete this relationship?')) return;
  const rel     = graphData.links.find(l => l.id === relId);
  const revLink  = rel ? graphData.links.find(l =>
    l.isReverse && l.person1Id === rel.person2Id && l.person2Id === rel.person1Id
  ) : null;

  const batch = db.batch();
  batch.delete(db.collection('relationships').doc(relId));
  if (revLink) batch.delete(db.collection('relationships').doc(revLink.id));

  await batch.commit();
  toast('Relationship deleted.');
  openConflicts();
}

/* ════════════════════════════════════════════════════════════
   12. LEFT PANEL PEOPLE LIST
════════════════════════════════════════════════════════════ */

function updatePeoplePanel() {
  document.getElementById('people-count').textContent = graphData.nodes.length;
  renderPeopleList(graphData.nodes);
}

function filterPeople() {
  const q = document.getElementById('search-input').value.toLowerCase();
  renderPeopleList(q
    ? graphData.nodes.filter(n => n.name.toLowerCase().includes(q))
    : graphData.nodes
  );
}

function renderPeopleList(nodes) {
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  const html = sorted.length
    ? sorted.map(n => `
        <div class="person-row" onclick="centreOnNode('${n.id}')">
          <span class="gender-dot ${n.gender}"></span>
          <span class="person-row-name">${escapeHtml(n.name)}</span>
          <span class="person-row-year">${n.dateOfBirth ? extractYear(n.dateOfBirth) : ''}</span>
        </div>`).join('')
    : '<p class="no-results">No results</p>';

  const wrapper = document.getElementById('people-list');
  // Wrap in scrollable inner div
  wrapper.innerHTML = `<div class="people-list-inner">${html}</div>`;
}

/* ════════════════════════════════════════════════════════════
   PERSON PICKER  –  searchable autocomplete replacing <select>
════════════════════════════════════════════════════════════ */

/** Show (or refresh) the dropdown for the picker that owns inputEl. */
function ppOpen(inputEl) {
  const wrap = inputEl.closest('.person-picker');
  if (wrap) _ppShowDrop(wrap, inputEl.value);
}

/** Filter dropdown as the user types; clear stale selection if text changed. */
function ppFilter(inputEl) {
  const wrap = inputEl.closest('.person-picker');
  if (!wrap) return;
  const hid = wrap.querySelector('input[type=hidden]');
  if (hid?.value) {
    const cur = graphData.nodes.find(n => n.id === hid.value);
    if (cur && inputEl.value !== cur.name) hid.value = '';
  }
  _ppShowDrop(wrap, inputEl.value);
}

/** Close dropdown on blur; if nothing selected clear the text. */
function ppBlur(inputEl) {
  const wrap = inputEl.closest('.person-picker');
  if (!wrap) return;
  setTimeout(() => {
    const drop = wrap.querySelector('.pp-dropdown');
    if (drop) drop.style.display = 'none';
    const hid = wrap.querySelector('input[type=hidden]');
    if (hid && !hid.value) inputEl.value = '';
  }, 160);
}

/** Called via onmousedown on a .pp-option — sets the hidden value and closes. */
function ppSelect(hidEl, personId) {
  const node = graphData.nodes.find(n => n.id === personId);
  if (!node || !hidEl) return;
  hidEl.value = personId;
  const wrap = hidEl.closest('.person-picker');
  if (wrap) {
    const inp = wrap.querySelector('.pp-input');
    if (inp) inp.value = node.name;
    const drop = wrap.querySelector('.pp-dropdown');
    if (drop) drop.style.display = 'none';
  }
  // Auto-run trace when both trace fields are filled
  if (hidEl.id === 'trace-p1' || hidEl.id === 'trace-p2') {
    const p1 = document.getElementById('trace-p1')?.value;
    const p2 = document.getElementById('trace-p2')?.value;
    if (p1 && p2) runTrace();
  }
}

/** Set a picker by the hidden input's id — used from pick-mode and external code. */
function ppSetById(hiddenId, personId) {
  const hEl = document.getElementById(hiddenId);
  if (!hEl) return;
  const node = graphData.nodes.find(n => n.id === personId);
  if (!node) return;
  hEl.value = personId;
  const wrap = hEl.closest('.person-picker');
  if (!wrap) return;
  const inp = wrap.querySelector('.pp-input');
  if (inp) inp.value = node.name;
  const drop = wrap.querySelector('.pp-dropdown');
  if (drop) drop.style.display = 'none';
}

/** Clear a picker by the hidden input's id. */
function ppClearById(hiddenId) {
  const hEl = document.getElementById(hiddenId);
  if (!hEl) return;
  hEl.value = '';
  const wrap = hEl.closest('.person-picker');
  if (!wrap) return;
  const inp = wrap.querySelector('.pp-input');
  if (inp) inp.value = '';
  const drop = wrap.querySelector('.pp-dropdown');
  if (drop) drop.style.display = 'none';
}

/** Build and show the dropdown list filtered by query. */
function _ppShowDrop(wrap, query) {
  const hid  = wrap.querySelector('input[type=hidden]');
  const drop = wrap.querySelector('.pp-dropdown');
  if (!drop) return;

  let nodes = [...graphData.nodes];
  // In quick-link modal, exclude the newly added person
  if (hid?.id === 'ql-other-person' && _quickLinkPersonId) {
    nodes = nodes.filter(n => n.id !== _quickLinkPersonId);
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name));

  const q       = (query || '').toLowerCase().trim();
  const matches = q ? nodes.filter(n => n.name.toLowerCase().includes(q)) : nodes;

  if (!matches.length) {
    drop.innerHTML = '<div class="pp-empty">No matches</div>';
    drop.style.display = 'block';
    return;
  }

  const curVal  = hid?.value || '';
  const hidId   = hid?.id    || '';
  drop.innerHTML = matches.map(n => {
    const sel = n.id === curVal ? ' selected' : '';
    // Use a safe data attribute approach; hidId cannot contain quotes in practice
    return `<div class="pp-option${sel}" onmousedown="ppSelect(document.getElementById('${hidId}'),'${n.id}')">${escapeHtml(n.name)}</div>`;
  }).join('');
  drop.style.display = 'block';
}

/* ════════════════════════════════════════════════════════════
   CHART SEARCH  –  highlight & pan to matching nodes
════════════════════════════════════════════════════════════ */

function searchChart(query) {
  const q       = (query || '').toLowerCase().trim();
  const clearBtn = document.getElementById('chart-search-clear');
  if (clearBtn) clearBtn.style.display = q ? 'inline-flex' : 'none';

  if (!q) {
    nodesLayer?.selectAll('.node-g').classed('search-match search-fade', false);
    return;
  }

  const matches  = graphData.nodes.filter(n => n.name.toLowerCase().includes(q));
  const matchIds = new Set(matches.map(n => n.id));

  nodesLayer.selectAll('.node-g')
    .classed('search-match', d => matchIds.has(d.id))
    .classed('search-fade',  d => !matchIds.has(d.id));

  // Pan to first match
  if (matches.length) {
    const first = matches[0];
    const svgEl = document.getElementById('chart-svg');
    const w = svgEl.clientWidth, h = svgEl.clientHeight;
    const t = d3.zoomTransform(svgEl);
    const tx = w / 2 - (first.x || 0) * t.k;
    const ty = h / 2 - (first.y || 0) * t.k;
    d3.select(svgEl).transition().duration(400)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(t.k));
  }
}

function clearChartSearch() {
  const inp = document.getElementById('chart-search');
  if (inp) inp.value = '';
  searchChart('');
}

function toggleHdrSearch(forceOpen) {
  const bar = document.getElementById('hdr-search-bar');
  const inp = document.getElementById('hdr-search-input');
  const btn = document.getElementById('hdr-search-btn');
  const hdr = document.getElementById('app-header');
  if (!bar) return;
  const open = forceOpen !== undefined ? forceOpen : !bar.classList.contains('open');
  // Position bar flush below the real header
  if (hdr) bar.style.top = hdr.getBoundingClientRect().bottom + 'px';
  bar.classList.toggle('open', open);
  if (btn) btn.style.opacity = open ? '1' : '';
  if (open) {
    setTimeout(() => inp && inp.focus(), 80);
  } else {
    if (inp) inp.value = '';
    searchChart('');
  }
}

function refreshPersonSelects() {
  // Pickers read from graphData.nodes dynamically – just evict stale selections
  ['rel-p1', 'rel-p2', 'trace-p1', 'trace-p2'].forEach(hidId => {
    const hEl = document.getElementById(hidId);
    if (hEl?.value && !graphData.nodes.find(n => n.id === hEl.value)) {
      ppClearById(hidId);
    }
  });
}

/* ════════════════════════════════════════════════════════════
   EXPORT  –  CSV / JSON / GEDCOM download
════════════════════════════════════════════════════════════ */

const REL_LABEL = {
  'parent':        'is Parent of',
  'child':         'is Child of',
  'sibling':       'is Sibling of',
  'spouse':        'is Spouse of',
  'parent-in-law': 'is Parent-in-law of',
  'child-in-law':  'is Child-in-law of',
  'sibling-in-law':'is Sibling-in-law of',
};

function openExportModal() {
  const pCount = graphData.nodes.length;
  const rCount = graphData.links.filter(l => !l.isReverse).length;
  document.getElementById('export-stats').innerHTML =
    `<span class="export-stat"><strong>${pCount}</strong> people</span>` +
    `<span class="export-stat-sep">·</span>` +
    `<span class="export-stat"><strong>${rCount}</strong> relationships</span>`;
  document.getElementById('modal-export').style.display = 'flex';
}

function _downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  const people = [...graphData.nodes].sort((a, b) => a.name.localeCompare(b.name));
  const rels   = graphData.links.filter(l => !l.isReverse);
  const esc    = v => `"${(v || '').replace(/"/g, '""')}"`;

  let csv = 'PEOPLE\r\nName,Gender,Date of Birth\r\n';
  people.forEach(p => {
    csv += `${esc(p.name)},${esc(p.gender)},${esc(p.dateOfBirth || '')}\r\n`;
  });

  csv += '\r\nRELATIONSHIPS\r\nPerson 1,Relationship,Person 2\r\n';
  rels.forEach(l => {
    const p1  = nodeById.get(l.person1Id)?.name || l.person1Id;
    const p2  = nodeById.get(l.person2Id)?.name || l.person2Id;
    const rel = REL_LABEL[l.relationshipType] || l.relationshipType;
    csv += `${esc(p1)},${esc(rel)},${esc(p2)}\r\n`;
  });

  _downloadFile(csv, 'pedigree-export.csv', 'text/csv;charset=utf-8;');
  closeModal('modal-export');
  toast('CSV downloaded ✓', 'success');
}

function exportJSON() {
  const people = [...graphData.nodes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => ({ name: p.name, gender: p.gender || null, dateOfBirth: p.dateOfBirth || null }));

  const relationships = graphData.links.filter(l => !l.isReverse).map(l => ({
    person1:      nodeById.get(l.person1Id)?.name || l.person1Id,
    relationship: l.relationshipType,
    person2:      nodeById.get(l.person2Id)?.name || l.person2Id,
  }));

  _downloadFile(
    JSON.stringify({ exportedAt: new Date().toISOString(), totalPeople: people.length, totalRelationships: relationships.length, people, relationships }, null, 2),
    'pedigree-export.json', 'application/json'
  );
  closeModal('modal-export');
  toast('JSON downloaded ✓', 'success');
}

function exportGEDCOM() {
  const nodes  = graphData.nodes;
  const links  = graphData.links.filter(l => !l.isReverse);
  const iTag   = new Map(nodes.map((n, i) => [n.id, `@I${i + 1}@`]));
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  // Build FAM records from spouse links + their shared children
  const famSeen = new Set();
  const families = [];
  let fi = 1;

  links.filter(l => l.relationshipType === 'spouse').forEach(l => {
    const key = [l.person1Id, l.person2Id].sort().join(':');
    if (famSeen.has(key)) return;
    famSeen.add(key);
    const childIds = [...new Set(
      links.filter(l2 => l2.relationshipType === 'parent' &&
        (l2.person1Id === l.person1Id || l2.person1Id === l.person2Id))
      .map(l2 => l2.person2Id)
    )];
    families.push({ famTag: `@F${fi++}@`, p1: l.person1Id, p2: l.person2Id, childIds });
  });

  // Single-parent families
  links.filter(l => l.relationshipType === 'parent').forEach(l => {
    const already = families.some(f =>
      (f.p1 === l.person1Id || f.p2 === l.person1Id) && f.childIds.includes(l.person2Id));
    if (already) return;
    let fam = families.find(f => (f.p1 === l.person1Id || f.p2 === l.person1Id) && !f.p2);
    if (!fam) { fam = { famTag: `@F${fi++}@`, p1: l.person1Id, p2: null, childIds: [] }; families.push(fam); }
    if (!fam.childIds.includes(l.person2Id)) fam.childIds.push(l.person2Id);
  });

  const childFamOf  = new Map();
  const spouseFamsOf = new Map(nodes.map(n => [n.id, []]));
  families.forEach(f => {
    f.childIds.forEach(cid => childFamOf.set(cid, f.famTag));
    if (f.p1) spouseFamsOf.get(f.p1)?.push(f.famTag);
    if (f.p2) spouseFamsOf.get(f.p2)?.push(f.famTag);
  });

  let ged = '0 HEAD\r\n1 GEDC\r\n2 VERS 5.5.1\r\n2 FORM LINEAGE-LINKED\r\n1 CHAR UTF-8\r\n1 SOUR Global-Pedigree-Chart\r\n2 NAME Global Pedigree Chart\r\n';

  nodes.forEach(n => {
    const tag   = iTag.get(n.id);
    const parts = n.name.trim().split(' ');
    const surn  = parts.length > 1 ? parts[parts.length - 1] : '';
    const givn  = parts.slice(0, surn ? -1 : undefined).join(' ') || n.name;
    const sex   = n.gender === 'male' ? 'M' : n.gender === 'female' ? 'F' : 'U';
    ged += `0 ${tag} INDI\r\n1 NAME ${givn}${surn ? ' /' + surn + '/' : ''}\r\n`;
    if (surn) ged += `2 SURN ${surn}\r\n`;
    if (givn) ged += `2 GIVN ${givn}\r\n`;
    ged += `1 SEX ${sex}\r\n`;
    if (n.dateOfBirth) {
      const [y, mo, d] = n.dateOfBirth.split('-');
      const gd = [d && d.padStart(2,'0'), mo && months[+mo-1], y].filter(Boolean).join(' ');
      ged += `1 BIRT\r\n2 DATE ${gd}\r\n`;
    }
    if (childFamOf.has(n.id))  ged += `1 FAMC ${childFamOf.get(n.id)}\r\n`;
    (spouseFamsOf.get(n.id)||[]).forEach(ft => { ged += `1 FAMS ${ft}\r\n`; });
  });

  families.forEach(f => {
    ged += `0 ${f.famTag} FAM\r\n`;
    const p1node = nodes.find(n => n.id === f.p1);
    const p2node = f.p2 ? nodes.find(n => n.id === f.p2) : null;
    if (f.p1) ged += `1 ${p1node?.gender === 'female' ? 'WIFE' : 'HUSB'} ${iTag.get(f.p1)}\r\n`;
    if (f.p2) ged += `1 ${p2node?.gender === 'female' ? 'WIFE' : 'HUSB'} ${iTag.get(f.p2)}\r\n`;
    f.childIds.forEach(cid => { ged += `1 CHIL ${iTag.get(cid)}\r\n`; });
  });

  ged += '0 TRLR\r\n';
  _downloadFile(ged, 'pedigree-export.ged', 'text/plain;charset=utf-8;');
  closeModal('modal-export');
  toast('GEDCOM downloaded ✓', 'success');
}


/* ════════════════════════════════════════════════════════════
   TRACE RELATIONSHIP  –  BFS shortest path between two members
════════════════════════════════════════════════════════════ */

/**
 * BFS on the undirected relationship graph.
 * Returns an array of steps:
 *   [{ nodeId }, { nodeId, via: { linkId, type } }, ...]
 * or null if no path exists.
 */
function findRelationshipPath(startId, endId) {
  if (startId === endId) return null;

  const visited = new Set([startId]);
  // Each queue entry is the full path from start to current node
  const queue = [[{ nodeId: startId }]];

  while (queue.length) {
    const path    = queue.shift();
    const current = path[path.length - 1].nodeId;

    for (const link of graphData.links) {
      let neighborId = null;
      let relType    = null;

      if (link.person1Id === current && !visited.has(link.person2Id)) {
        neighborId = link.person2Id;
        relType    = link.relationshipType;
      } else if (link.person2Id === current && !visited.has(link.person1Id)) {
        neighborId = link.person1Id;
        relType    = getInverse(link.relationshipType);
      }

      if (!neighborId) continue;
      visited.add(neighborId);

      // Find the canonical (non-reverse) link id for highlighting
      const visLink = graphData.links.find(l =>
        !l.isReverse && (
          (l.person1Id === current    && l.person2Id === neighborId) ||
          (l.person1Id === neighborId && l.person2Id === current)
        )
      );

      const newPath = [...path, { nodeId: neighborId, via: { linkId: visLink?.id, type: relType } }];

      if (neighborId === endId) return newPath;
      queue.push(newPath);
    }
  }

  return null; // no connection
}

/** Called when the user clicks "Find Path" in the Trace section. */
function runTrace() {
  const p1Id = document.getElementById('trace-p1').value;
  const p2Id = document.getElementById('trace-p2').value;

  if (!p1Id || !p2Id)         return toast('Select two people to trace.', 'error');
  if (p1Id === p2Id)           return toast('Select two different people.', 'error');

  // Clear any existing node-click selection
  deselectNode();

  const path = findRelationshipPath(p1Id, p2Id);
  activeTracePath = path;

  applyTraceHighlight(path, p1Id, p2Id);
  renderTraceResult(path, p1Id, p2Id);
}

/** Clears the trace and restores normal graph appearance. */
function clearTrace() {
  activeTracePath = null;
  nodesLayer.selectAll('.node-g').classed('in-path start-node end-node path-faded', false);
  linksLayer.selectAll('.link-g').classed('path-active path-faded', false);
  document.getElementById('trace-result').innerHTML = '';
  ppClearById('trace-p1');
  ppClearById('trace-p2');
}

/** Applies CSS classes to nodes/links to visualise the path. */
function applyTraceHighlight(path, p1Id, p2Id) {
  if (!path) {
    // No path – fade everything, keep the two selected nodes visible
    nodesLayer.selectAll('.node-g')
      .classed('in-path',    d => d.id === p1Id || d.id === p2Id)
      .classed('path-faded', d => d.id !== p1Id && d.id !== p2Id)
      .classed('start-node end-node', false);
    linksLayer.selectAll('.link-g')
      .classed('path-active', false)
      .classed('path-faded',  true);
    return;
  }

  const pathNodeIds = new Set(path.map(s => s.nodeId));
  const pathLinkIds = new Set(path.slice(1).map(s => s.via?.linkId).filter(Boolean));

  nodesLayer.selectAll('.node-g')
    .classed('in-path',    d => pathNodeIds.has(d.id) && d.id !== p1Id && d.id !== p2Id)
    .classed('start-node', d => d.id === p1Id)
    .classed('end-node',   d => d.id === p2Id)
    .classed('path-faded', d => !pathNodeIds.has(d.id));

  linksLayer.selectAll('.link-g')
    .classed('path-active', d => pathLinkIds.has(d.id))
    .classed('path-faded',  d => !pathLinkIds.has(d.id));
}

/** Renders the step-by-step chain in the left panel result area. */
function renderTraceResult(path, p1Id, p2Id) {
  const p1 = nodeById.get(p1Id);
  const p2 = nodeById.get(p2Id);
  const resultEl = document.getElementById('trace-result');

  if (!path) {
    resultEl.innerHTML = `
      <div class="trace-no-path">
        <span>🔗</span>
        <p><strong>${escapeHtml(p1?.name || '?')}</strong> and <strong>${escapeHtml(p2?.name || '?')}</strong> are not connected in the tree yet.</p>
      </div>`;
    return;
  }

  const degrees = path.length - 1;
  let html = `<div class="trace-degrees">${degrees} degree${degrees !== 1 ? 's' : ''} of separation</div>
    <div class="path-chain">`;

  path.forEach((step, i) => {
    const node   = nodeById.get(step.nodeId);
    const name   = node ? node.name : 'Unknown';
    const gender = node?.gender || 'other';
    const bg     = GENDER_COLORS[gender];
    const isEnd  = i === 0 || i === path.length - 1;

    html += `<div class="path-step${isEnd ? ' path-step-end' : ''}" onclick="centreOnNode('${step.nodeId}')">
      <div class="path-avatar" style="background:${bg}">${gender === 'male' ? '♂' : gender === 'female' ? '♀' : '⚧'}</div>
      <span class="path-name">${escapeHtml(name)}</span>
    </div>`;

    if (i < path.length - 1) {
      const nextVia    = path[i + 1].via;
      const relType    = nextVia?.type || '—';
      const relLabel   = getDisplayType(relType, step.nodeId);
      const relColor   = LINK_COLORS[relType] || '#94a3b8';
      html += `<div class="path-connector">
        <span class="path-conn-line" style="background:${relColor}"></span>
        <span class="path-conn-label" style="color:${relColor}">${relLabel}</span>
        <span class="path-conn-line" style="background:${relColor}"></span>
      </div>`;
    }
  });

  html += '</div>';
  resultEl.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════
   13. PANEL RESIZE HANDLE
════════════════════════════════════════════════════════════ */

function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const panel  = document.querySelector('.left-panel');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = 'col-resize';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.max(200, Math.min(440, startW + e.clientX - startX));
    panel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor     = '';
  });
}

/* ════════════════════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════════════════ */

/** Shorten a name to fit inside a node rectangle. */
function abbreviate(name, maxLen = 13) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) {
    // First name + last initial
    const candidate = parts[0] + ' ' + parts[parts.length - 1][0] + '.';
    if (candidate.length <= maxLen) return candidate;
    return parts[0].substring(0, maxLen);
  }
  return name.length > maxLen ? name.substring(0, maxLen - 1) + '…' : name;
}

/** Extract 4-digit year from an ISO date string. */
function extractYear(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr).getUTCFullYear(); } catch { return ''; }
}

/* ════════════════════════════════════════════════════════════
   14. SUGGEST CONNECTIONS
   Analyses the existing graph structure and proposes likely
   missing relationships using three heuristics:
     1. Shared-parent siblings  – two people who have the same
        parent but are not yet marked as siblings.
     2. Co-parent spouses       – two people who are both listed
        as a parent of the same child but have no spouse link.
     3. Spouse's children       – if A is the spouse of B and B
        is already a parent of C, A may also be a parent of C.
════════════════════════════════════════════════════════════ */

/**
 * Build lookup maps and run all three heuristics.
 * Returns an array of suggestion objects, excluding any that
 * the user has already ignored this session.
 */
function generateSuggestions() {
  const parentToChildren = new Map(); // parentId → Set<childId>
  const childToParents   = new Map(); // childId  → Set<parentId>
  const spouseMap        = new Map(); // personId → Set<spouseId>
  const siblingMap       = new Map(); // personId → Set<siblingId>
  const existingPairs    = new Set(); // normalized "idA:idB" for every visible link

  // ── Build lookup structures from visible (non-reverse) links ──
  graphData.links.forEach(l => {
    if (l.isReverse) return;

    const key = [l.person1Id, l.person2Id].sort().join(':');
    existingPairs.add(key);

    // parent-child: handle both 'parent' and 'child' forward links so lookup
    // maps are populated regardless of which direction the user entered the link.
    if (l.relationshipType === 'parent') {
      // person1 is parent of person2
      if (!parentToChildren.has(l.person1Id)) parentToChildren.set(l.person1Id, new Set());
      parentToChildren.get(l.person1Id).add(l.person2Id);
      if (!childToParents.has(l.person2Id)) childToParents.set(l.person2Id, new Set());
      childToParents.get(l.person2Id).add(l.person1Id);
    }
    if (l.relationshipType === 'child') {
      // person1 is child of person2 → person2 is parent of person1
      if (!parentToChildren.has(l.person2Id)) parentToChildren.set(l.person2Id, new Set());
      parentToChildren.get(l.person2Id).add(l.person1Id);
      if (!childToParents.has(l.person1Id)) childToParents.set(l.person1Id, new Set());
      childToParents.get(l.person1Id).add(l.person2Id);
    }
    if (l.relationshipType === 'sibling') {
      [l.person1Id, l.person2Id].forEach(id => {
        if (!siblingMap.has(id)) siblingMap.set(id, new Set());
      });
      siblingMap.get(l.person1Id).add(l.person2Id);
      siblingMap.get(l.person2Id).add(l.person1Id);
    }
    if (l.relationshipType === 'spouse') {
      [l.person1Id, l.person2Id].forEach(id => {
        if (!spouseMap.has(id)) spouseMap.set(id, new Set());
      });
      spouseMap.get(l.person1Id).add(l.person2Id);
      spouseMap.get(l.person2Id).add(l.person1Id);
    }
  });

  const suggestions = [];
  const seen        = new Set();

  function pairKey(a, b) { return [a, b].sort().join(':'); }

  function push(p1Id, p2Id, relType, reason, confidence) {
    if (p1Id === p2Id) return;
    const pKey = pairKey(p1Id, p2Id);
    if (existingPairs.has(pKey)) return;            // link already exists
    const sugId = pKey + ':' + relType;
    if (seen.has(sugId)) return;                    // deduplicate
    seen.add(sugId);
    suggestions.push({ id: sugId, person1Id: p1Id, person2Id: p2Id, relationshipType: relType, reason, confidence });
  }

  // ── Heuristic 1: shared-parent siblings ──────────────────
  for (const [parentId, children] of parentToChildren) {
    const arr        = [...children];
    const parentName = nodeById.get(parentId)?.name || 'someone';
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        push(arr[i], arr[j], 'sibling',
          `Both are children of ${parentName}`, 'high');
      }
    }
  }

  // ── Heuristic 2: co-parent spouses ───────────────────────
  for (const [childId, parents] of childToParents) {
    const arr       = [...parents];
    const childName = nodeById.get(childId)?.name || 'someone';
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        // Skip if they're already siblings (unlikely spouses)
        if (siblingMap.get(a)?.has(b)) continue;
        push(a, b, 'spouse',
          `Both are parents of ${childName}`, 'medium');
      }
    }
  }

  // ── Heuristic 3: spouse's children ───────────────────────
  for (const [personId, spouseIds] of spouseMap) {
    const personName = nodeById.get(personId)?.name || 'someone';
    for (const spouseId of spouseIds) {
      const spouseChildren = parentToChildren.get(spouseId) || new Set();
      const spouseName     = nodeById.get(spouseId)?.name || 'their spouse';
      for (const childId of spouseChildren) {
        const childName = nodeById.get(childId)?.name || 'a child';
        push(personId, childId, 'parent',
          `${personName} is spouse of ${spouseName}, who is parent of ${childName}`, 'medium');
      }
    }
  }

  // ── Heuristic 4: parent-in-law ────────────────────────────
  // If A is spouse of B, and C is parent of B → C is parent-in-law of A.
  for (const [personId, spouseIds] of spouseMap) {
    const personName = nodeById.get(personId)?.name || 'someone';
    for (const spouseId of spouseIds) {
      const spouseParents = childToParents.get(spouseId) || new Set();
      const spouseName    = nodeById.get(spouseId)?.name || 'their spouse';
      for (const parentId of spouseParents) {
        const parentName = nodeById.get(parentId)?.name || 'someone';
        push(parentId, personId, 'parent-in-law',
          `${parentName} is a parent of ${spouseName}, who is married to ${personName}`, 'high');
      }
    }
  }

  // ── Heuristic 5: parent of sibling ───────────────────────
  // If A is child of B, and A is sibling of C → B is also parent of C.
  for (const [childId, parents] of childToParents) {
    const siblings  = siblingMap.get(childId) || new Set();
    const childName = nodeById.get(childId)?.name || 'someone';
    for (const parentId of parents) {
      const parentName = nodeById.get(parentId)?.name || 'someone';
      for (const siblingId of siblings) {
        const siblingName = nodeById.get(siblingId)?.name || 'someone';
        push(parentId, siblingId, 'parent',
          `${parentName} is a parent of ${childName}, who is a sibling of ${siblingName}`, 'high');
      }
    }
  }

  // ── Heuristic 6: sibling-in-law (spouse's sibling) ────────
  // If A is spouse of B, and C is sibling of B → C is sibling-in-law of A.
  for (const [personId, spouseIds] of spouseMap) {
    const personName = nodeById.get(personId)?.name || 'someone';
    for (const spouseId of spouseIds) {
      const spouseSiblings = siblingMap.get(spouseId) || new Set();
      const spouseName     = nodeById.get(spouseId)?.name || 'their spouse';
      for (const siblingId of spouseSiblings) {
        if (siblingId === personId) continue;
        const siblingName = nodeById.get(siblingId)?.name || 'someone';
        push(personId, siblingId, 'sibling-in-law',
          `${siblingName} is a sibling of ${spouseName}, who is married to ${personName}`, 'high');
      }
    }
  }

  // ── Heuristic 6: sibling-in-law (sibling's spouse) ────────
  // If A is sibling of B, and C is spouse of B → C is sibling-in-law of A.
  for (const [personId, siblings] of siblingMap) {
    const personName = nodeById.get(personId)?.name || 'someone';
    for (const siblingId of siblings) {
      const siblingSpouses = spouseMap.get(siblingId) || new Set();
      const siblingName    = nodeById.get(siblingId)?.name || 'their sibling';
      for (const spouseId of siblingSpouses) {
        if (spouseId === personId) continue;
        const spouseName = nodeById.get(spouseId)?.name || 'someone';
        push(personId, spouseId, 'sibling-in-law',
          `${spouseName} is married to ${siblingName}, who is ${personName}'s sibling`, 'high');
      }
    }
  }

  return suggestions;
}

/** Opens the modal, rescanning the graph fresh each time. */
function openSuggestionsModal() {
  currentSuggestions = generateSuggestions();
  renderSuggestionsModal();
  document.getElementById('modal-suggestions').style.display = 'flex';
}

/** Clears the current list and rescans every connection from scratch. */
function rescanSuggestions() {
  currentSuggestions = [];          // clear first so stale cards disappear immediately
  renderSuggestionsModal();
  currentSuggestions = generateSuggestions();
  renderSuggestionsModal();
  toast(`Found ${currentSuggestions.length} suggestion${currentSuggestions.length !== 1 ? 's' : ''}.`, 'success');
}

/** Renders suggestion cards into the modal body. */
function renderSuggestionsModal() {
  const body = document.getElementById('suggestions-body');

  if (currentSuggestions.length === 0) {
    body.innerHTML = `<div class="sug-empty"><span>🌳</span><p>No new suggestions right now.<br/>Add more people and relationships to get suggestions.</p></div>`;
    return;
  }

  body.innerHTML = currentSuggestions.map(sug => {
    const p1         = nodeById.get(sug.person1Id);
    const p2         = nodeById.get(sug.person2Id);
    const color      = LINK_COLORS[sug.relationshipType] || '#94a3b8';
    const badgeLabel = getDisplayType(sug.relationshipType, sug.person1Id);
    const conf       = sug.confidence === 'high'
      ? '<span class="sug-conf high">High confidence</span>'
      : '<span class="sug-conf medium">Medium confidence</span>';
    const safeId     = sug.id.replace(/'/g, "\\'");

    return `
      <div class="sug-card">
        <div class="sug-people">
          <div class="sug-person">
            <div class="sug-avatar" style="background:${GENDER_COLORS[p1?.gender] || '#8b5cf6'}">
              ${p1?.gender === 'male' ? '♂' : p1?.gender === 'female' ? '♀' : '⚧'}
            </div>
            <span class="sug-name">${escapeHtml(p1?.name || '?')}</span>
          </div>
          <div class="sug-rel-badge" style="color:${color};border-color:${color}">${badgeLabel}</div>
          <div class="sug-person">
            <div class="sug-avatar" style="background:${GENDER_COLORS[p2?.gender] || '#8b5cf6'}">
              ${p2?.gender === 'male' ? '♂' : p2?.gender === 'female' ? '♀' : '⚧'}
            </div>
            <span class="sug-name">${escapeHtml(p2?.name || '?')}</span>
          </div>
        </div>
        <div class="sug-reason">${escapeHtml(sug.reason)}</div>
        <div class="sug-footer">
          ${conf}
          <div class="sug-actions">
            <button class="btn-primary sug-btn" onclick="acceptSuggestion('${safeId}')">Accept</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

/** Accept a suggestion – write the relationship to Firestore. */
async function acceptSuggestion(sugId) {
  const sug = currentSuggestions.find(s => s.id === sugId);
  if (!sug) return;

  const { person1Id, person2Id, relationshipType } = sug;
  const inverseType = getInverse(relationshipType);
  const conflict    = detectConflict(person1Id, relationshipType, person2Id);
  const batch       = db.batch();

  const fwdRef = db.collection('relationships').doc();
  batch.set(fwdRef, {
    person1Id,
    person2Id,
    relationshipType,
    createdBy:  currentUser.uid,
    createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
    isReverse:  false,
    conflicted: conflict
  });

  if (relationshipType !== inverseType) {
    const revRef = db.collection('relationships').doc();
    batch.set(revRef, {
      person1Id:        person2Id,
      person2Id:        person1Id,
      relationshipType: inverseType,
      createdBy:        currentUser.uid,
      createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
      isReverse:        true,
      conflicted:       conflict
    });
  }

  try {
    await batch.commit();
    logActivity('accept_suggestion', {
      person1Id, person1Name: nodeById.get(person1Id)?.name || person1Id,
      person2Id, person2Name: nodeById.get(person2Id)?.name || person2Id,
      relationshipType, reason: sug.reason || ''
    });
    currentSuggestions = currentSuggestions.filter(s => s.id !== sugId);
    renderSuggestionsModal();
    toast('Relationship added!', 'success');
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

// Cancel pick mode on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickMode) exitPickMode();
});

/** Toggle the left panel open / closed. */
function togglePanel() {
  const panel   = document.getElementById('left-panel');
  const btn     = document.getElementById('hamburger-btn');
  const body    = document.querySelector('.app-body');
  const overlay = document.getElementById('panel-overlay');
  const mobile  = window.innerWidth <= 768;

  if (mobile) {
    // Mobile: slide drawer in/out with mobile-open class
    const open = panel.classList.toggle('mobile-open');
    if (overlay) overlay.classList.toggle('visible', open);
  } else {
    // Desktop: push-collapse
    const collapsed = panel.classList.toggle('collapsed');
    btn.classList.toggle('open', collapsed);
    body.classList.toggle('panel-collapsed', collapsed);
    if (overlay) overlay.classList.remove('visible');
    setTimeout(fitView, 300);
  }
}

/** Simple XSS-safe string. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
