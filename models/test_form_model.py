import joblib
import numpy as np

# Load model
model = joblib.load("models/form_model.pkl")
print("\n=== Model loaded successfully! ===\n")

# # Regex fallback rules (disabled for now)
# def regex_fallback(label: str):
#     """Rule-based shortcuts for obvious fields"""
#     text = label.lower()

#     # Email
#     if "email" in text:
#         return "email"

#     # Phone numbers
#     if any(word in text for word in ["phone", "contact", "mobile", "cell", "telephone"]):
#         return "phone"

#     # Address fields
#     if any(word in text for word in ["zip", "postal", "postcode"]):
#         return "address"
#     if any(word in text for word in ["city", "town", "municipality"]):
#         return "address"
#     if any(word in text for word in ["state", "province", "region"]):
#         return "address"
#     if any(word in text for word in ["country", "nation"]):
#         return "address"
#     if "street" in text or "address" in text:
#         return "address"

#     # Name
#     if "name" in text or "surname" in text:
#         return "name"

#     # Date of birth
#     if "date of birth" in text or "dob" in text or "birth" in text:
#         return "birth_date"

#     # Ethnicity
#     if "ethnicity" in text or "race" in text:
#         return "ethnicity"

#     # Gender
#     if "gender" in text:
#         return "gender"

#     # Work authorization
#     if "authorized to work" in text or "work authorization" in text or "sponsorship" in text:
#         return "work_auth"

#     return None  # no match, fall back to ML

# Test some labels (ML only for now)
sample_labels = [
    "First Name",
    "Last Name",
    "Email Address",
    "Zip Code",
    "Street Address",
    "Phone Number",
    "City",
    "Ethnicity",
    "Date of Birth",
]

probabilities = model.predict_proba(sample_labels)
classes = model.classes_

print("=== Sample Predictions (ML only) ===")
for label, probs in zip(sample_labels, probabilities):
    pred_idx = np.argmax(probs)
    pred_class = classes[pred_idx]
    confidence = probs[pred_idx]
    print(f"Label: '{label}' -> Predicted: '{pred_class}' (confidence: {confidence:.2f})")

# print("=== Sample Predictions with Regex Fallback ===")
# for label in sample_labels:
#     rule = regex_fallback(label)
#     if rule:
#         print(f"Label: '{label}' -> Predicted (rule): {rule}")
#     else:
#         pred = model.predict([label])[0]
#         print(f"Label: '{label}' -> Predicted (ML): {pred}")

if __name__ == "__main__":
    # Interactive loop (only runs if you execute `python models/test_form_model.py`)
    while True:
        user_input = input("\nEnter a form label (or type 'quit' to exit): ")
        if user_input.lower() == "quit":
            break

        # Uncomment below to re-enable regex later
        # rule = regex_fallback(user_input)
        # if rule:
        #     print(f"Predicted (rule): {rule}")
        # else:
        #     pred = model.predict([user_input])[0]
        #     print(f"Predicted (ML): {pred}")

        probs = model.predict_proba([user_input])[0]
        pred_idx = np.argmax(probs)
        pred_class = classes[pred_idx]
        confidence = probs[pred_idx]
        print(f"Predicted: '{pred_class}' (confidence: {confidence:.2f})")
