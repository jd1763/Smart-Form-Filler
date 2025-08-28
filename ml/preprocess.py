import os
import re
import nltk
from nltk.corpus import stopwords

# Download the NLTK stopwords list if it's not already installed
# (this only runs the first time)
nltk.download("stopwords")

# Load the list of English stopwords into a set for fast lookup
stop_words = set(stopwords.words("english"))

def clean_text(text: str) -> str:
    """
    Cleans and normalizes text for NLP.
    Steps:
      1. Convert to lowercase
      2. Remove punctuation and special characters (only keep letters, numbers, spaces)
      3. Split into tokens (words)
      4. Remove stopwords like 'the', 'is', 'and'
      5. Rejoin tokens back into a cleaned string
    """
    # Lowercase all text
    text = text.lower()
    
    # Replace anything not a-z, 0-9, or space with a space
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    
    # Split string into list of words
    tokens = text.split()
    
    # Remove common stopwords (e.g., "and", "the", "of")
    tokens = [t for t in tokens if t not in stop_words]
    
    # Join tokens back into one string
    return " ".join(tokens)

def process_folder(input_folder: str, output_folder: str):
    """
    Reads all .txt files from input_folder, cleans them using clean_text(),
    and saves the cleaned text to output_folder with the same filename.
    """
    # Make sure output folder exists, if not create it
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)

    # Loop over all files in the input folder
    for filename in os.listdir(input_folder):
        if filename.endswith(".txt"):  # only process text files
            in_path = os.path.join(input_folder, filename)   # input file path
            out_path = os.path.join(output_folder, filename) # output file path

            # Read raw file contents
            with open(in_path, "r", encoding="utf-8") as f:
                raw_text = f.read()

            # Clean the text using our function
            cleaned = clean_text(raw_text)

            # Write cleaned text to the output folder
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(cleaned)

            print(f"Processed {filename} -> {out_path}")

if __name__ == "__main__":
    # Figure out where the dataset folder is
    base_dir = os.path.join(os.path.dirname(__file__), "..", "dataset")

    # Input/output for job descriptions
    jobs_in = os.path.join(base_dir, "jobs")
    jobs_out = os.path.join(base_dir, "jobs_clean")
    process_folder(jobs_in, jobs_out)

    # Input/output for resumes
    resumes_in = os.path.join(base_dir, "resumes")
    resumes_out = os.path.join(base_dir, "resumes_clean")
    process_folder(resumes_in, resumes_out)

    print("Preprocessing complete! Cleaned files saved in jobs_clean/ and resumes_clean/")
