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

  // Populate the "other person" select with all current nodes except the new one
  const sel = document.getElementById('ql-other-person');
  sel.innerHTML = '<option value="">— select a person —</option>';
  graphData.nodes
    .filter(n => n.id !== newId)
    .sort((a,b) => a.name.localeCompare(b.name))
    .forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = n.name;
      sel.appendChild(opt);
    });

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

  // Deselect node/link on background click; also cancel pick mode
  svgSel.on('click', () => {
    if (pickMode) { exitPickMode(); return; }
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
    .on('click', (event, d) => {
      event.stopPropagation();
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
    document.getElementById(field).value = id;
    const name = nodeById.get(id)?.name || 'Person';
    exitPickMode();
    toast(`${name} selected`, 'success');
    // Auto-run trace when both endpoints are set
    if (field === 'trace-p1' || field === 'trace-p2') {
      const p1 = document.getElementById('trace-p1').value;
      const p2 = document.getElementById('trace-p2').value;
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
  document.getElementById('ip-actions').style.display = (isOwner || isAdmin) ? 'flex' : 'none';
  document.getElementById('ip-btn-delete').style.display = isAdmin ? 'inline-flex' : 'none';

  document.getElementById('info-panel').style.display = 'flex';
}

/** Called from info panel Edit button */
function ipEdit() {
  if (!selectedNodeId) return;
  const node = nodeById.get(selectedNodeId);
  if (!node) return;
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
  try {
    await db.collection('nodes').doc(id).update({
      name, gender,
      dateOfBirth: dob,
      updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy:   currentUser.uid
    });
    closeModal('modal-edit');
    toast('Changes saved!', 'success');
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function deleteSelectedNode() {
  if (!selectedNodeId || currentProfile.role !== 'admin') return;
  const node = nodeById.get(selectedNodeId);
  if (!node) return;
  if (!confirm(`Permanently delete "${node.name}" and all their relationships?`)) return;

  try {
    const batch = db.batch();
    batch.delete(db.collection('nodes').doc(selectedNodeId));

    // Delete all relationships that involve this node
    graphData.links
      .filter(l => l.person1Id === selectedNodeId || l.person2Id === selectedNodeId)
      .forEach(l => batch.delete(db.collection('relationships').doc(l.id)));

    await batch.commit();
    closeModal('modal-node');
    deselectNode();
    toast(`"${node.name}" deleted.`);
  } catch (err) {
    toast('Error: ' + err.message, 'error');
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

function refreshPersonSelects() {
  const sorted = [...graphData.nodes].sort((a, b) => a.name.localeCompare(b.name));
  const opts   = sorted.map(n => `<option value="${n.id}">${escapeHtml(n.name)}</option>`).join('');

  ['rel-p1', 'rel-p2', 'trace-p1', 'trace-p2'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">Select person *</option>` + opts;
    sel.value = cur;
  });
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
  document.getElementById('trace-p1').value = '';
  document.getElementById('trace-p2').value = '';
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
  const panel  = document.getElementById('left-panel');
  const btn    = document.getElementById('hamburger-btn');
  const body   = document.querySelector('.app-body');
  const collapsed = panel.classList.toggle('collapsed');
  btn.classList.toggle('open', collapsed);
  body.classList.toggle('panel-collapsed', collapsed);
  // Re-fit the chart so it fills the new width after the transition
  setTimeout(fitView, 300);
}

/** Simple XSS-safe string. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
