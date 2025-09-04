import os
import sys
from ml import preprocess

# Ensure parent directory is in sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_clean_text_basic():
    """Check that clean_text lowercases, removes punctuation and stopwords."""
    raw = "The QUICK brown fox, jumped over THE lazy dog!"
    cleaned = preprocess.clean_text(raw)

    assert "quick" in cleaned
    assert "brown" in cleaned
    assert "fox" in cleaned
    assert "lazy" in cleaned
    assert "dog" in cleaned
    assert "the" not in cleaned  # stopword removed


def test_process_folder(tmp_path):
    """Ensure process_folder cleans and saves files properly."""
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    output_dir.mkdir()

    # Write a sample file
    input_file = input_dir / "sample.txt"
    input_file.write_text("Hello WORLD! This is a TEST.", encoding="utf-8")

    # Run processor
    preprocess.process_folder(str(input_dir), str(output_dir))

    # Verify cleaned output
    output_file = output_dir / "sample.txt"
    assert output_file.exists()
    cleaned = output_file.read_text(encoding="utf-8")

    assert "hello" in cleaned
    assert "world" in cleaned
    assert "test" in cleaned
    assert "this" not in cleaned  # stopword removed
