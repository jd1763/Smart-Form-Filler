# tests/value_resolver.py
import re


def flatten_profile(p):
    """Flatten nested profile.json into the fields used by tests & filler."""
    p = dict(p or {})
    personal = p.get("personal", p)
    address = p.get("address", {}) or {}
    links = p.get("links", {}) or {}
    exp0 = (
        (p.get("experience") or [{}])[0]
        if isinstance(p.get("experience"), list)
        else (p.get("experience") or {})
    )

    first = (personal.get("firstName") or "").strip()
    last = (personal.get("lastName") or "").strip()
    full = (personal.get("fullName") or "").strip()
    if not full and (first or last):
        full = f"{first} {last}".strip()

    phone = personal.get("phoneNumber") or personal.get("phone") or ""
    # normalize simple formats e.g. remove spaces
    phone = re.sub(r"\s+", "", phone)

    flat = {
        "firstName": first or (full.split()[0] if full else ""),
        "lastName": last or (full.split()[-1] if full and len(full.split()) > 1 else ""),
        "fullName": full,
        "email": personal.get("email", ""),
        "phoneNumber": phone,
        "dob": personal.get("dob", "") or personal.get("date_of_birth", ""),
        "gender": personal.get("gender", ""),
        "street": address.get("street", "")
        or address.get("address1", "")
        or address.get("address_line1", ""),
        "city": address.get("city", "") or address.get("town", ""),
        "state": address.get("state", "")
        or address.get("province", "")
        or address.get("region", ""),
        "zip": address.get("zip", "")
        or address.get("postal", "")
        or address.get("postcode", "")
        or address.get("zipcode", ""),
        "country": address.get("country", ""),
        "linkedin": links.get("linkedin", ""),
        "github": links.get("github", "") or links.get("portfolio", ""),
        "website": links.get("website", ""),
        "company": (exp0 or {}).get("company", ""),
        "jobTitle": (exp0 or {}).get("jobTitle", ""),
        "start_date": (
            f"{int(exp0.get('startMonth')):02d}/{exp0.get('startYear')}"
            if exp0.get("startMonth") and exp0.get("startYear")
            else ""
        ),
        "end_date": (
            f"{int(exp0.get('endMonth')):02d}/{exp0.get('endYear')}"
            if exp0.get("endMonth") and exp0.get("endYear")
            else ""
        ),
    }

    # Eligibility flags (derive booleans/strings if present)
    # We'll include keys referenced by tests even if blank.
    flat["workAuthorization"] = str(
        p.get("eligibility", {}).get("workAuthorization", "")
        or personal.get("workAuthorization", "")
    )
    flat["requiresSponsorship"] = str(
        p.get("eligibility", {}).get("requiresSponsorship", "")
        or personal.get("requiresSponsorship", "")
    )

    # Defensive: uppercase country to match some tests
    if flat["country"]:
        flat["country"] = flat["country"].upper()

    return flat


# Optional: stub used by tests if your real predictor is not callable here.
def predict_stub(labels):
    out = []
    for lab in labels:
        s = lab.lower()
        if "first" in s:
            out.append("firstName")
        elif "surname" in s or "last" in s or "family" in s:
            out.append("lastName")
        elif "email" in s:
            out.append("email")
        elif "mobile" in s or "phone" in s:
            out.append("phoneNumber")
        elif "birth" in s or "dob" in s:
            out.append("dob")
        elif "gender" in s:
            out.append("gender")
        elif "address" in s and "line" in s:
            out.append("street")
        elif "street" in s:
            out.append("street")
        elif "city" in s or "town" in s:
            out.append("city")
        elif "state" in s or "province" in s or "region" in s:
            out.append("state")
        elif "zip" in s or "postal" in s or "postcode" in s:
            out.append("zip")
        elif "country" in s or "nation" in s:
            out.append("country")
        else:
            out.append(None)
    return out
