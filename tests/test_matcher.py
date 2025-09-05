import os
import sys
import tempfile

from matcher import baseline_matcher as bm

# Ensure project root is in path
sys.path.append(os.path.abspath("."))


def test_normalize_text_lemmatization():
    """Check that lemmatization reduces words to base form."""
    raw = "Developing developers developed"
    clean = bm.normalize_text(raw)

    assert "develop" in clean
    assert "developing" not in clean


def test_load_texts_from_folder():
    """Ensure load_texts_from_folder reads files correctly."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sample_path = os.path.join(tmpdir, "sample.txt")
        with open(sample_path, "w", encoding="utf-8") as f:
            f.write("hello world")

        texts = bm.load_texts_from_folder(tmpdir)

        assert "sample" in texts
        assert texts["sample"] == "hello world"


def test_similarity_matrix_runs():
    """Check cosine similarity runs and outputs valid scores."""
    resumes = {"resume1": "python developer flask sql"}
    jobs = {"job1": "backend developer flask sql"}

    all_docs = list(resumes.values()) + list(jobs.values())
    vectorizer = bm.TfidfVectorizer(stop_words="english")
    tfidf_matrix = vectorizer.fit_transform(all_docs)

    resume_vectors = tfidf_matrix[: len(resumes)]
    job_vectors = tfidf_matrix[len(resumes) :]

    sim_matrix = bm.cosine_similarity(resume_vectors, job_vectors)

    assert sim_matrix.shape == (1, 1)
    assert 0.0 <= sim_matrix[0][0] <= 1.0
