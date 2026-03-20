/**
 * firebase-config.js
 * ==================
 * Replace the placeholder values below with your actual Firebase project
 * credentials from the Firebase Console → Project Settings → General → Your apps.
 *
 * ADMIN_EMAIL: The email address that automatically receives the "admin" role
 * on first registration, regardless of whether they are the first user.
 * Leave blank ("") to make ONLY the very first registered user the admin.
 */

const firebaseConfig = {
  apiKey: "AIzaSyBddwlF8YIq_X2UNVqf2QG86FO_mWkavqQ",
  authDomain: "legacyledger.firebaseapp.com",
  projectId: "legacyledger",
  storageBucket: "legacyledger.firebasestorage.app",
  messagingSenderId: "994420381676",
  appId: "1:994420381676:web:17491607d7c226cd4b12c9"
};

// Optional: hardcode an admin email so that account is always promoted to admin
const ADMIN_EMAIL = "sandeshjain91@gmail.com";

// Initialise Firebase (compat SDK loaded via CDN in index.html)
firebase.initializeApp(firebaseConfig);
