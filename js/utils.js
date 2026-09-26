// ==========================================
// LINKUP SHARED UI HELPERS
// ==========================================
//
// Small pure functions that were previously copy-pasted into every
// app page — and had already drifted into two different versions of
// getErrorMessage() and three of formatDate().
//
// Loaded after supabase.js on every app page. No dependencies.

// Turn a Supabase/PostgREST error into something worth showing.
// PostgrestError carries { message, details, hint, code } and the hint
// is usually the actionable half ("duplicate key value violates unique
// constraint"), so keep it instead of dropping it.
function getErrorMessage(err) {
    if (!err) return "Something went wrong. Please try again.";
    if (typeof err === "string") return err;

    var message = (err.message || "").trim();
    var hint = (err.hint || "").trim();
    var details = (err.details || "").trim();

    if (message && hint && message !== hint) return message + " " + hint;
    return message || hint || details || "Something went wrong. Please try again.";
}

// "5 Oct 2026", or a fallback when the value is missing or unparseable.
function formatDate(value, fallback) {
    var text = fallback || "Date TBA";
    if (!value) return text;

    var d = new Date(value);
    if (isNaN(d.getTime())) return text;

    return d.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric"
    });
}

// "5 Oct 2026, 4:30 pm"
function formatDateTime(value, fallback) {
    var text = fallback || "Date TBA";
    if (!value) return text;

    var d = new Date(value);
    if (isNaN(d.getTime())) return text;

    return d.toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });
}

// connections.status -> human label
function connectionStatusLabel(status) {
    switch (status) {
        case "accepted": return "Connected";
        case "rejected": return "Declined";
        case "archived": return "Archived";
        default: return "Pending";
    }
}

// opportunities.status -> human label
function opportunityStatusLabel(status) {
    return status === "open" ? "Open" : "Closed";
}

// 1 opportunity / 2 opportunities
function plural(count, singular, pluralForm) {
    var n = Number(count) || 0;
    return n + " " + (n === 1 ? singular : (pluralForm || singular + "s"));
}

// Build a <div class="status status--x"> chip.
function statusChip(status, label) {
    var chip = document.createElement("span");
    chip.className = "status status--" + (
        status === "accepted" || status === "open" ? "accepted" :
        status === "rejected" || status === "closed" ? "rejected" : "pending"
    );
    chip.textContent = label || connectionStatusLabel(status);
    return chip;
}

// Small helper for the repeated "toggle a .form-message" dance.
function setFormMessage(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("error", "success");
    if (text) el.classList.add(isError ? "error" : "success");
    el.style.display = text ? "block" : "none";
}

function hideFormMessage(el) {
    if (!el) return;
    el.textContent = "";
    el.classList.remove("error", "success");
    el.style.display = "none";
}
