# tests/golden_form_mapping.py

GOLDEN_LABELS = [
    # Personal
    "First Name",
    "Surname",
    "Email Address",
    "Mobile Number",
    "Date of Birth (MM/DD/YYYY)",
    "Your Birth Date",
    "Gender",
    # Address
    "Street Address",
    "Address Line 1",
    "City / Town",
    "City",
    "State / Province / Region",
    "Zip / Postal Code / Postcode",
    "Postal Code",
    "Country / Nation",
    # Links
    "LinkedIn Profile URL",
    "Portfolio / GitHub / Personal Website",
    # Education
    "Highest Degree",
    "University / College / Institute",
    "Field of Study",
    "Year of Graduation",
    # Employment (current)
    "Company Name",
    "Employer Name",
    "Your Job Title",
    "Start Date",
    "End Date",
    "Role Description / Key Responsibilities / Duties",
    # Employment (previous)
    "Organization",
    "Previous Employer",
    "Position Title",
    "Official Job Title",
    "Employment Start",
    "Employment End Date",
    "Job Duties / Work Responsibilities",
    # Eligibility
    "Are you authorized to work in the US?",
    "Will you now or in the future require sponsorship?",
    # Documents
    "Upload Resume (Resume File / CV Upload)",
    "Cover Letter / Additional Information",
]

# Canonical + common variants (tests normalize further)
GOLDEN_EXPECTED_KEYS = {
    "firstName","lastName","fullName",
    "email","phoneNumber","dob","gender",
    "street","city","state","zip","country",
    "linkedin","github","website",
    "highestDegree","university","fieldOfStudy","graduationYear",
    "company","jobTitle","start_date","end_date","roleDescription",
    "previousEmployer",
    "workAuthorization","requiresSponsorship",
    "resumeFile","coverLetter",

    # frequent raw variants your model has emitted
    "name","phone","birth_date","zipcode","postal","postcode","address",
    "address1","address_line1","major","college","institute","title",
    "organization","employer","employername","companyname",
    "positiontitle","officialjobtitle",
}
