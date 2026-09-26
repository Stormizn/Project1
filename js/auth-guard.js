// ==========================================
// LINKUP AUTH GUARD
// ==========================================
//
// Shared helpers for private pages
// (dashboard, profile, discover, ...).
//
// requireSession():
//   - Checks whether a user is logged in.
//   - If not, redirects to login.html and
//     returns null (page should stop).
//   - If yes, loads { user, profile, error }.
//
// getInitials():
//   - Turns "Alex Sharma" into "AS".
//
// getDisplayName(auth, fallback):
//   - Resolves the name to show in the sidebar and greetings.
//   - Prefers the profile name, then the local part of the
//     sign-in email, then the fallback.
//   - The public `users` table has no email column, so the
//     email always comes from the Supabase auth user.

async function requireSession() {
    // 1. Check if the user is signed in via Supabase
    const { data: { session }, error: sessionError } = await window.supabaseClient.auth.getSession();

    if (sessionError || !session) {
        window.location.href = "../auth/login.html";
        return null;
    }

    // 2. Fetch the custom profile from the users table
    const { data: profile, error: profileError } = await window.supabaseClient
        .from('users')
        .select('*')
        .eq('id', session.user.id)
        .single();

    if (profileError || !profile) {
        console.error("Failed to load user profile:", profileError);
        window.supabaseClient.auth.signOut();
        window.location.href = "../auth/login.html";
        return null;
    }

    // 3. Return the user and their profile.
    return {
        user: session.user,
        profile: profile,
        error: null
    };
}

// Sign the current user out and return to the login screen.
async function signOut() {
    await window.supabaseClient.auth.signOut();
    window.location.href = "../auth/login.html";
}


function getInitials(fullName) {

    const name = fullName || "LinkUp";

    return name
        .split(" ")
        .map(function(word) {
            return word.charAt(0);
        })
        .join("")
        .slice(0, 2)
        .toUpperCase();

}

function getDisplayName(auth, fallback) {

    var defaultName = fallback || "LinkUp User";

    if (!auth) return defaultName;

    var profileName = (auth.profile && auth.profile.name)
        ? auth.profile.name.trim()
        : "";

    if (profileName) return profileName;

    var email = (auth.user && auth.user.email) ? auth.user.email : "";

    if (email) return email.split("@")[0];

    return defaultName;

}
