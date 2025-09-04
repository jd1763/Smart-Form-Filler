import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
import joblib

# 1. Load dataset
# Form_labels.csv has two columns:
#   - "label_text": the raw label from the form (ex: "First Name", "Email Address", "Zip Code")
#   - "field_type": the standardized category (ex: "name", "email", "zip")
# This is what we’ll train the model to predict.
data = pd.read_csv("dataset/form_labels_balanced.csv")

X = data["label_text"]   # input: raw text from the form labels
y = data["field_type"]   # output: target category we want the model to learn

# 2. Train/test split
# We split into training and testing sets so we can measure how well the model generalizes
# instead of just memorizing the training data.
# test_size=0.2 means 20% of the data is used for testing.
# Use stratify only if all classes have >= 2 samples
if y.value_counts().min() > 1:
    stratify_option = y
else:
    stratify_option = None  # fallback if rare classes exist

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=stratify_option
)

# 3. Build pipeline (TF-IDF + Logistic Regression)
# A Pipeline lets us chain together multiple steps so we don’t repeat ourselves.
# Steps:
#   (a) TfidfVectorizer → converts raw text into numeric vectors using TF-IDF
#   (b) MultinomialNB → a Naive Bayes classifier designed for text/count data
#
# Why TF-IDF?
#   - It gives higher weight to important words ("email") and lower weight to common words ("the").
#   - We also use ngram_range=(1,3) so it captures single words ("name"), pairs of words ("first name") and 3-word chunks ("What is your")
#
# Why Logistic Regression?
#   - Strong baseline for text classification.
#   - Handles overlapping features better than Naive Bayes.
#   - Works well once each class has enough examples
model = Pipeline([
    ("tfidf", TfidfVectorizer(ngram_range=(1,3))),  
    ("clf", LogisticRegression(max_iter=2000))
])

# 4. Train Model
# We fit (train) the model on the training data.
model.fit(X_train, y_train)

# 5. Evaluate Model
# Now we predict on the test set and print metrics.
# classification_report shows:
#   - precision: how many predicted labels were correct
#   - recall: how many true labels we correctly found
#   - f1-score: balance between precision & recall
#   - support: number of examples in each class
y_pred = model.predict(X_test)
print("=== Model Evaluation on Test Data ===")
print(classification_report(y_test, y_pred, zero_division=0))

# 6. Save model
# Finally, we save the entire pipeline (TF-IDF +  Naive Bayes) to disk.
# This way, when we load it later, we don’t need to re-train or redefine the vectorizer.
joblib.dump(model, "models/form_model.pkl")
print("=== Model saved to models/form_model.pkl ===")
