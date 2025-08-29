import sys, os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import tempfile
from ml import preprocess

def test_clean_text_basic():
    # Input text with mixed case, punctuation, and stopwords
    raw = "The QUICK brown fox, jumped over THE lazy dog!"
    cleaned = preprocess.clean_text(raw)
    
    # Words like "the" and punctuation should be removed
    assert "quick" in cleaned
    assert "brown" in cleaned
    assert "fox" in cleaned
    assert "lazy" in cleaned
    assert "dog" in cleaned
    assert "the" not in cleaned  # stopword removed

def test_process_folder(tmp_path):
    # Create a temporary folder for input
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    output_dir.mkdir()

    # Write a sample file
    input_file = input_dir / "sample.txt"
    input_file.write_text("Hello WORLD! This is a TEST.", encoding="utf-8")

    # Run the processor
    preprocess.process_folder(str(input_dir), str(output_dir))

    # Check that the output file exists and is cleaned
    output_file = output_dir / "sample.txt"
    assert output_file.exists()
    cleaned = output_file.read_text(encoding="utf-8")
    assert "hello" in cleaned
    assert "world" in cleaned
    assert "test" in cleaned
    assert "this" not in cleaned  # stopword removed
