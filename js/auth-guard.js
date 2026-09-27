// ==========================================
// LINKZYFY AUTH GUARD
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
//   IMPORTANT: a failure to READ the profile never signs the
//   user out. Only a genuinely missing session redirects to
//   the login screen. Signing out on a read error used to
//   bounce people back to login even though their password
//   was correct (see the self-heal path below).
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

// How long to wait for the Supabase SDK to hand back a session
// before giving up. Without this a hung request leaves the page
// sitting on "Loading…" forever.
var SESSION_TIMEOUT_MS = 8000;

// How long to wait for the profile row before deciding it is
// missing. RLS rejections and network blips are fast to surface.
var PROFILE_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, label) {
    if (!promise || typeof promise.then !== "function") return Promise.resolve(promise);

    return new Promise(function (resolve, reject) {
        var settled = false;

        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error(label + " timed out after " + ms + "ms"));
        }, ms);

        promise.then(
            function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            function (err) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

// Build a profile row out of the metadata Supabase stored at
// signup. This mirrors public.handle_new_user() in SQL so the
// browser can repair a profile the trigger never created.
function profileFromMetadata(user) {
    var meta = (user && user.user_metadata) || {};

    var name = typeof meta.name === "string" ? meta.name.trim() : "";
    if (!name && user && user.email) name = user.email.split("@")[0];

    var role = meta.role === "event_planner" ? "event_planner" : "brand";

    function clean(value) {
        if (typeof value !== "string") return null;
        var trimmed = value.trim();
        return trimmed === "" ? null : trimmed;
    }

    return {
        id: user.id,
        name: name || "Linkzyfy User",
        role: role,
        organization_name: clean(meta.organization_name),
        location: clean(meta.location),
        category: clean(meta.category)
    };
}

async function fetchProfile(userId) {
    var result = await withTimeout(
        window.supabaseClient
            .from("users")
            .select("*")
            .eq("id", userId)
            .maybeSingle(),
        PROFILE_TIMEOUT_MS,
        "Profile lookup"
    );

    return result;
}

async function createProfile(user) {
    var row = profileFromMetadata(user);

    var result = await withTimeout(
        window.supabaseClient.from("users").insert(row),
        PROFILE_TIMEOUT_MS,
        "Profile creation"
    );

    if (result.error) {
        // 23505 = unique violation. Another tab (or the database
        // trigger) created the row first, which is fine.
        if (result.error.code === "23505") return { error: null };
        return { error: result.error };
    }

    return { error: null, row: row };
}

async function requireSession() {
    // 1. Check if the user is signed in via Supabase.
    //
    // getSession() reads from local storage, so it normally
    // resolves almost instantly. The timeout only exists to stop
    // a wedged SDK from hanging the page.
    var sessionResult;

    try {
        sessionResult = await withTimeout(
            window.supabaseClient.auth.getSession(),
            SESSION_TIMEOUT_MS,
            "Session lookup"
        );
    } catch (err) {
        console.error("Could not read the Supabase session:", err);
        // We genuinely do not know whether this visitor is signed
        // in. Do NOT sign them out — send them to login, which
        // will simply sign them straight back in.
        window.location.href = "../auth/login.html";
        return null;
    }

    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

    if (!session) {
        window.location.href = "../auth/login.html";
        return null;
    }

    var user = session.user;

    // 2. Fetch the custom profile from the users table.
    var profile = null;
    var profileError = null;

    try {
        var result = await fetchProfile(user.id);
        profileError = result.error || null;
        profile = result.data || null;
    } catch (err) {
        profileError = err;
    }

    // 3. No profile row at all.
    //
    // This happens when the database trigger
    // public.handle_new_user() is not installed, so signup
    // created an auth user but never a public.users row. Repair
    // it here instead of throwing the session away.
    if (!profile && (!profileError || profileError.code === "PGRST116")) {
        var created = await createProfile(user);

        if (created.error) {
            console.error("Could not create the missing profile:", created.error);
        } else {
            var retry = await fetchProfile(user.id).catch(function () {
                return { data: created.row, error: null };
            });
            profile = retry.data || created.row || null;
        }
    }

    // 4. Still nothing. This is a read problem (RLS, offline,
    //    server error) — NOT a bad password. Keep the session and
    //    let the page render its error state. Signing out here is
    //    what caused the "logged in, then bounced to login" loop.
    if (!profile) {
        console.error("Failed to load user profile:", profileError);
        return {
            user: user,
            profile: null,
            error: profileError || new Error("Profile unavailable")
        };
    }

    // 5. Return the user and their profile.
    return {
        user: user,
        profile: profile,
        error: null
    };
}

// Sign the current user out and return to the login screen.
async function signOut() {
    try {
        await window.supabaseClient.auth.signOut();
    } catch (err) {
        console.error("Sign out failed:", err);
    }
    window.location.href = "../auth/login.html";
}


// Catch a session that expires or is revoked while the user is
// on a private page. Without this the page keeps rendering stale
// data until the next click.
function watchSessionExpiry() {
    if (!window.supabaseClient || !window.supabaseClient.auth) return;

    window.supabaseClient.auth.onAuthStateChange(function (event, session) {
        if (event === "SIGNED_OUT" || (!session && event !== "INITIAL_SESSION")) {
            window.location.href = "../auth/login.html";
        }
    });
}


function getInitials(fullName) {

    var name = fullName || "Linkzyfy";

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

    var defaultName = fallback || "Linkzyfy User";

    if (!auth) return defaultName;

    var profileName = (auth.profile && auth.profile.name)
        ? auth.profile.name.trim()
        : "";

    if (profileName) return profileName;

    var email = (auth.user && auth.user.email) ? auth.user.email : "";

    if (email) return email.split("@")[0];

    return defaultName;

}
