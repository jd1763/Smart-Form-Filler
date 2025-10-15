# train_form_model.py
import joblib
import pandas as pd
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

from pathlib import Path
# Point to the repo root (one level up from /models)
REPO = Path(__file__).resolve().parents[1]

candidates = [
    REPO / "dataset" / "form_labels_balanced.csv",
    REPO / "dataset" / "form_labels.csv",
]

csv_path = None
for p in candidates:
    if p.exists():
        csv_path = p
        break
if not csv_path:
    raise FileNotFoundError("Could not find form_labels*.csv in expected locations.")

data = pd.read_csv(csv_path)
# Expect columns: label_text, field_type
data = data.dropna(subset=["label_text", "field_type"]).copy()

X = data["label_text"].astype(str)
y = data["field_type"].astype(str)

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.20, random_state=42, stratify=y
)

# Char-level TF-IDF handles typos/case/punctuations in tiny labels extremely well
model = Pipeline(
    steps=[
        ("tfidf", TfidfVectorizer(
            lowercase=True,
            strip_accents="unicode",
            analyzer="char_wb",       # word-boundary char n-grams are great for short labels
            ngram_range=(2, 6),       # captures substrings like "cou", "county", "zip"
            min_df=1,
            sublinear_tf=True
        )),
        ("clf", LogisticRegression(
            solver="lbfgs",
            max_iter=2000,
            C=2.0,                    # a tad more capacity
            class_weight="balanced",  # helps recall on under-represented classes
            multi_class="auto"
        )),
])

model.fit(X_train, y_train)
y_pred = model.predict(X_test)
print("=== Model Evaluation on Test Data ===")
print(classification_report(y_test, y_pred, zero_division=0))

out_path = REPO / "models" / "form_model.pkl"
joblib.dump(model, out_path)
print(f"=== Model saved to {out_path} ===")
