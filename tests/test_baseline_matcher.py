import os
import sys
import tempfile

from matcher import baseline_matcher as bm

# Ensure project root is in the import path
# (so Python can find matcher/ when tests run)
sys.path.append(os.path.abspath("."))


def test_normalize_text_lemmatization():
    """
    Test that normalize_text() applies lemmatization.

    Example:
        "Developing developers developed"
        -> should normalize to just "develop"
    """
    raw = "Developing developers developed"
    clean = bm.normalize_text(raw)

    # Expect base form "develop" to be in the result
    assert "develop" in clean
    # Inflected forms should be gone
    assert "developing" not in clean


def test_load_texts_from_folder():
    """
    Test that load_texts_from_folder() reads text files properly.

    It should:
    - Read each .txt file in a folder
    - Store them in a dict {filename: contents}
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        # Make a fake text file
        sample_path = os.path.join(tmpdir, "sample.txt")
        with open(sample_path, "w", encoding="utf-8") as f:
            f.write("hello world")

        # Run the function
        texts = bm.load_texts_from_folder(tmpdir)

        # Validate results
        assert "sample" in texts  # key = filename (without .txt)
        assert texts["sample"] == "hello world"  # value = file contents


def test_similarity_matrix_runs():
    """
    Test cosine similarity pipeline with dummy resume + job text.

    Steps:
    - Build TF-IDF vectors for resumes + jobs
    - Compare them with cosine similarity
    - Ensure result is a valid similarity score (0 ≤ score ≤ 1)
    """
    resumes = {"resume1": "python developer flask sql"}
    jobs = {"job1": "backend developer flask sql"}

    # Vectorize both sets of docs
    all_docs = list(resumes.values()) + list(jobs.values())
    vectorizer = bm.TfidfVectorizer(stop_words="english")
    tfidf_matrix = vectorizer.fit_transform(all_docs)

    # Split into resume vectors and job vectors
    resume_vectors = tfidf_matrix[: len(resumes)]
    job_vectors = tfidf_matrix[len(resumes):]

    # Compute similarity
    sim_matrix = bm.cosine_similarity(resume_vectors, job_vectors)

    # Sanity checks
    assert sim_matrix.shape == (1, 1)  # one resume × one job
    assert 0.0 <= sim_matrix[0][0] <= 1.0  # score shou_
