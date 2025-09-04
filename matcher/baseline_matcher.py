import os
import glob
import nltk
import re
from nltk.stem import WordNetLemmatizer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Download resources if missing
nltk.download("punkt", quiet=True)
nltk.download("punkt_tab", quiet=True)
nltk.download("wordnet", quiet=True)
nltk.download("omw-1.4", quiet=True)

lemmatizer = WordNetLemmatizer()


def normalize_text(text: str) -> str:
    """
    Clean and normalize text for TF-IDF.
    Steps:
    1. Lowercase
    2. Remove punctuation/numbers
    3. Tokenize into words
    4. Lemmatize each word (developer, developing -> develop)
    """
    # Lowercase
    text = text.lower()
    # Remove punctuation & digits
    text = re.sub(r"[^a-z\s]", " ", text)
    # Tokenize
    tokens = nltk.word_tokenize(text)
    # Lemmatize each word
    tokens = [lemmatizer.lemmatize(tok) for tok in tokens]
    return " ".join(tokens)

# --- Function to load all .txt files from a folder ---


def load_texts_from_folder(folder_path):
    texts = {}
    for filepath in glob.glob(os.path.join(folder_path, "*.txt")):
        name = os.path.basename(filepath).replace(".txt", "")  # file name only, no extension
        with open(filepath, "r", encoding="utf-8") as f:
            texts[name] = f.read()  # read the whole text file into memory
    return texts  # return dictionary file name -> file content


# --- Main ---
if __name__ == "__main__":
    # Load resumes and job descriptions into dictionaries
    # Each dictionary maps "filename" -> "file content"
    resumes = load_texts_from_folder("dataset/resumes_clean")
    jobs = load_texts_from_folder("dataset/jobs_clean")

    # Combine all documents (resumes + jobs) into a single list normalized/cleaned
    # We need to pass *all* texts into TF-IDF so it can learn vocab across both sets.
    all_docs = [normalize_text(txt) for txt in resumes.values()] + \
        [normalize_text(txt) for txt in jobs.values()]

    # Keep labels (filenames) to reference later
    labels = list(resumes.keys()) + list(jobs.keys())

    # Turn text into TF-IDF vectors
    #   - TF (Term Frequency): how often a word appears in a document
    #   - IDF (Inverse Document Frequency): gives less weight to common words
    #   - Together: highlights words that are unique & important in each doc
    #   - stop_words="english": ignore common words like "the", "is", "and"
    #   - ngram_range=(1,2) -> includes bigrams (“machine learning”) not just unigrams.
    #   - max_features=5000 -> limits vocabulary size, reduces noise.
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=5000)
    tfidf_matrix = vectorizer.fit_transform(all_docs)

    # Split TF-IDF matrix back into resumes and jobs
    #   - First N rows are resumes
    #   - Remaining rows are jobs
    resume_vectors = tfidf_matrix[:len(resumes)]
    job_vectors = tfidf_matrix[len(resumes):]

    # Compute cosine similarity
    #   - Cosine similarity measures angle between two vectors
    #   - Closer to 1.0 = more similar (same direction)
    #   - Closer to 0.0 = less similar (different direction)
    similarity_matrix = cosine_similarity(resume_vectors, job_vectors)

    # --- Print results sorted by score ---
    print("\n=== Top Matches Per Resume ===\n")
    for i, resume_name in enumerate(resumes.keys()):
        # Collect all job scores for this resume
        job_scores = [
            (job_name, similarity_matrix[i][j])
            for j, job_name in enumerate(jobs.keys())
        ]
        # Sort jobs by similarity (highest first)
        job_scores.sort(key=lambda x: x[1], reverse=True)

        print(f"\nTop matches for {resume_name}:\n")
        for job_name, score in job_scores[:3]:  # top 3 matches only
            print(f"  -> {job_name:20s} | Score: {score:.3f}")
