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

// proposals.status -> human label.
//
// Five values, and the wording matters: "Declined" is a decision the
// planner made, "Withdrawn" is the brand walking away, and they are not
// the same thing to the person on the other side.
function proposalStatusLabel(status) {
    switch (status) {
        case "proposed": return "Awaiting review";
        case "changes_requested": return "Changes requested";
        case "accepted": return "Accepted";
        case "rejected": return "Declined";
        case "withdrawn": return "Withdrawn";
        default: return "Unknown";
    }
}

// The three states a proposal can be edited in. Kept here so the list
// page, the detail page and the tests all agree on one list.
var PROPOSAL_EDITABLE = ["proposed", "changes_requested"];
var PROPOSAL_FINAL = ["accepted", "rejected", "withdrawn"];

function isProposalEditable(status) {
    return PROPOSAL_EDITABLE.indexOf(status) !== -1;
}

function isProposalFinal(status) {
    return PROPOSAL_FINAL.indexOf(status) !== -1;
}

// A proposal is only worth showing money for if there is money.
// Returns "" when there is none, so the caller can fall back.
function formatMoney(amount, currency) {
    if (amount === null || amount === undefined || amount === "") return "";

    var value = Number(amount);
    if (isNaN(value)) return "";

    try {
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: (currency || "INR").toUpperCase(),
            maximumFractionDigits: 0
        }).format(value);
    } catch (err) {
        // An invalid currency code throws a RangeError. Showing the bare
        // number beats showing nothing.
        return String(value);
    }
}

// Postgres/PostgREST error codes that mean "this table or column is not
// on the database yet", which is what happens when the migration has
// not been run. The raw PostgREST string is worse than useless in a UI,
// so callers turn it into a sentence.
function isMissingTable(err) {
    if (!err) return false;
    return err.code === "42P01"
        || err.code === "PGRST205"
        || err.code === "PGRST204"
        || /does not exist/i.test(err.message || "");
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

// The same chip, but the colour follows the proposal state machine.
// "Changes requested" is still live, so it stays neutral rather than
// reading as a rejection; both final-but-not-accepted states read as
// closed.
function proposalStatusChip(status) {
    var chip = document.createElement("span");
    chip.className = "status status--" + (
        status === "accepted" ? "accepted" :
        PROPOSAL_FINAL.indexOf(status) !== -1 ? "rejected" : "pending"
    );
    chip.textContent = proposalStatusLabel(status);
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
