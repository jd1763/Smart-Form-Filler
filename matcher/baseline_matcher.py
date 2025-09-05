import os
import glob
import re
import nltk
from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Ensure NLTK resources are available
nltk.download("punkt", quiet=True)
nltk.download("punkt_tab", quiet=True)
nltk.download("averaged_perceptron_tagger", quiet=True)      # old name
nltk.download("averaged_perceptron_tagger_eng", quiet=True)  # new name (>=3.9)
nltk.download("wordnet", quiet=True)
nltk.download("omw-1.4", quiet=True)
nltk.download("stopwords", quiet=True)

lemmatizer = WordNetLemmatizer()
stop_words = set(stopwords.words("english"))

def get_wordnet_pos(tag):
    """Map POS tag to first character lemmatize() accepts."""
    from nltk.corpus.reader.wordnet import NOUN, VERB, ADJ, ADV

    if tag.startswith("J"):
        return ADJ
    elif tag.startswith("V"):
        return VERB
    elif tag.startswith("N"):
        return NOUN
    elif tag.startswith("R"):
        return ADV
    else:
        return NOUN

def normalize_text(text: str) -> str:
    """Lowercase, tokenize, remove stopwords, and lemmatize with POS."""
    tokens = nltk.word_tokenize(text.lower())
    tagged = nltk.pos_tag(tokens)  # get part of speech
    lemmatized = [
        lemmatizer.lemmatize(word, get_wordnet_pos(tag))
        for word, tag in tagged
        if word.isalpha() and word not in stop_words
    ]
    return " ".join(lemmatized)

# --- Function to load all .txt files from a folder ---
def load_texts_from_folder(folder_path: str):
    """Load all .txt files from a folder into a dict."""
    texts = {}
    for fname in os.listdir(folder_path):
        if fname.endswith(".txt"):
            with open(os.path.join(folder_path, fname), "r", encoding="utf-8") as f:
                texts[os.path.splitext(fname)[0]] = f.read()
    return texts

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
