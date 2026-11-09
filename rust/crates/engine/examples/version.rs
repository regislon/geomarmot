fn main() {
    let (v, p) = geomarmot_engine::version_and_platform().unwrap();
    println!("{v} {p}");
}
