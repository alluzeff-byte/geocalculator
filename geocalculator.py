import math
import re
import tkinter as tk
from tkinter import ttk, messagebox

# WGS84 ellipsoid parameters
WGS84_A = 6378137.0  # semi-major axis, meters
WGS84_F = 1 / 298.257223563  # flattening
WGS84_B = (1 - WGS84_F) * WGS84_A  # semi-minor axis, meters

KM_PER_NM = 1.852  # international nautical mile

NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def parse_coordinate(text, is_latitude):
    """Parse a coordinate string into decimal degrees.

    Accepts formats such as:
        "54.67N", "-34.11", "56° 34.56' N", "56° 34' 54'' W"
    """
    axis_name = "Latitude" if is_latitude else "Longitude"
    raw = text.strip()
    if not raw:
        raise ValueError(f"{axis_name} field is empty.")

    direction = None
    if raw[-1].upper() in "NSEW":
        direction = raw[-1].upper()
        raw = raw[:-1].strip()
    elif raw[0].upper() in "NSEW":
        direction = raw[0].upper()
        raw = raw[1:].strip()

    if direction is not None:
        expected = "NS" if is_latitude else "EW"
        if direction not in expected:
            raise ValueError(
                f"{axis_name} direction letter must be one of '{expected[0]}'/'{expected[1]}', got '{direction}'."
            )

    numbers = NUMBER_RE.findall(raw)
    if not numbers:
        raise ValueError(f"Could not find any numbers in {axis_name.lower()} value '{text}'.")
    if len(numbers) > 3:
        raise ValueError(f"Too many numeric components in {axis_name.lower()} value '{text}'.")

    values = [float(n) for n in numbers]
    sign_from_number = -1.0 if values[0] < 0 else 1.0
    values = [abs(v) for v in values]

    degrees = values[0]
    minutes = values[1] if len(values) > 1 else 0.0
    seconds = values[2] if len(values) > 2 else 0.0

    if minutes >= 60 or seconds >= 60:
        raise ValueError(f"Minutes/seconds must be less than 60 in {axis_name.lower()} value '{text}'.")

    decimal_degrees = degrees + minutes / 60.0 + seconds / 3600.0

    if direction is not None:
        sign = -1.0 if direction in "SW" else 1.0
    else:
        sign = sign_from_number

    decimal_degrees *= sign

    limit = 90 if is_latitude else 180
    if not (-limit <= decimal_degrees <= limit):
        raise ValueError(f"{axis_name} must be between -{limit} and {limit} degrees, got {decimal_degrees}.")

    return decimal_degrees


def vincenty_distance_km(lat1, lon1, lat2, lon2, max_iterations=200, tolerance=1e-12):
    """Precise ellipsoidal geodesic distance on WGS84 using Vincenty's inverse formula."""
    a, f, b = WGS84_A, WGS84_F, WGS84_B

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    L = math.radians(lon2 - lon1)

    U1 = math.atan((1 - f) * math.tan(phi1))
    U2 = math.atan((1 - f) * math.tan(phi2))
    sinU1, cosU1 = math.sin(U1), math.cos(U1)
    sinU2, cosU2 = math.sin(U2), math.cos(U2)

    lam = L
    cos_sq_alpha = cos2_sigma_m = sin_sigma = cos_sigma = sigma = 0.0

    for _ in range(max_iterations):
        sin_lam, cos_lam = math.sin(lam), math.cos(lam)
        sin_sigma = math.sqrt(
            (cosU2 * sin_lam) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cos_lam) ** 2
        )
        if sin_sigma == 0:
            return 0.0  # coincident points

        cos_sigma = sinU1 * sinU2 + cosU1 * cosU2 * cos_lam
        sigma = math.atan2(sin_sigma, cos_sigma)
        sin_alpha = cosU1 * cosU2 * sin_lam / sin_sigma
        cos_sq_alpha = 1 - sin_alpha ** 2

        if cos_sq_alpha != 0:
            cos2_sigma_m = cos_sigma - 2 * sinU1 * sinU2 / cos_sq_alpha
        else:
            cos2_sigma_m = 0.0  # equatorial line

        c = f / 16 * cos_sq_alpha * (4 + f * (4 - 3 * cos_sq_alpha))
        lam_prev = lam
        lam = L + (1 - c) * f * sin_alpha * (
            sigma + c * sin_sigma * (cos2_sigma_m + c * cos_sigma * (-1 + 2 * cos2_sigma_m ** 2))
        )
        if abs(lam - lam_prev) < tolerance:
            break
    else:
        raise ValueError("Distance calculation did not converge (points may be nearly antipodal).")

    u_sq = cos_sq_alpha * (a ** 2 - b ** 2) / (b ** 2)
    big_a = 1 + u_sq / 16384 * (4096 + u_sq * (-768 + u_sq * (320 - 175 * u_sq)))
    big_b = u_sq / 1024 * (256 + u_sq * (-128 + u_sq * (74 - 47 * u_sq)))
    delta_sigma = big_b * sin_sigma * (
        cos2_sigma_m
        + big_b
        / 4
        * (
            cos_sigma * (-1 + 2 * cos2_sigma_m ** 2)
            - big_b / 6 * cos2_sigma_m * (-3 + 4 * sin_sigma ** 2) * (-3 + 4 * cos2_sigma_m ** 2)
        )
    )
    distance_m = b * big_a * (sigma - delta_sigma)

    return distance_m / 1000.0


class GeoCalculatorApp:
    FORMAT_LABELS = (("dd", "dd.dd"), ("dm", "dd mm.mm"), ("dms", "dd mm ss.ss"))

    def __init__(self, root):
        self.root = root
        root.title("Geo Calculator")
        root.resizable(False, False)

        frame = ttk.Frame(root, padding=20)
        frame.grid(row=0, column=0, sticky="nsew")

        fields = [
            ("Point 1", "Latitude", "lat1", True),
            (None, "Longitude", "lon1", False),
            ("Point 2", "Latitude", "lat2", True),
            (None, "Longitude", "lon2", False),
        ]
        self.field_meta = {key: is_lat for _, _, key, is_lat in fields}
        self.ordered_keys = [key for _, _, key, _is_lat in fields]

        self.coord_containers = {}
        self.coord_widgets = {}

        row = 0
        for section_title, label_text, key, _is_lat in fields:
            if section_title is not None:
                ttk.Label(frame, text=section_title, font=("Segoe UI", 10, "bold")).grid(
                    row=row, column=0, columnspan=2, sticky="w", pady=(10 if row else 0, 2)
                )
                row += 1
            ttk.Label(frame, text=label_text + ":").grid(row=row, column=0, sticky="w", pady=5)
            container = ttk.Frame(frame)
            container.grid(row=row, column=1, sticky="w", padx=(10, 0), pady=5)
            self.coord_containers[key] = container
            row += 1

        self.format_var = tk.StringVar(value="dd")
        for key in self.ordered_keys:
            self.build_coord_widgets(key, "dd")
        self.rebuild_tab_order()

        format_frame = ttk.Frame(frame)
        format_frame.grid(row=row, column=0, columnspan=2, sticky="w", pady=(15, 0))
        row += 1

        ttk.Label(format_frame, text="Format:").pack(side="left")
        for value, label in self.FORMAT_LABELS:
            ttk.Radiobutton(
                format_frame, text=label, variable=self.format_var, value=value, command=self.on_format_change
            ).pack(side="left", padx=(10, 0))

        calc_button = ttk.Button(frame, text="Calculate", command=self.on_calculate)
        calc_button.grid(row=row, column=0, columnspan=2, pady=(15, 5), sticky="ew")
        row += 1

        units_frame = ttk.Frame(frame)
        units_frame.grid(row=row, column=0, columnspan=2, sticky="w", pady=(5, 0))
        row += 1

        ttk.Label(units_frame, text="Units:").pack(side="left")
        self.unit_var = tk.StringVar(value="km")
        for unit_value in ("km", "m", "nm"):
            ttk.Radiobutton(units_frame, text=unit_value, variable=self.unit_var, value=unit_value).pack(
                side="left", padx=(10, 0)
            )
        self.unit_var.trace_add("write", lambda *args: self.update_result_display())

        self.result_var = tk.StringVar(value="Distance: -")
        result_label = ttk.Label(frame, textvariable=self.result_var, font=("Segoe UI", 11, "bold"))
        result_label.grid(row=row, column=0, columnspan=2, pady=(10, 0))

        self.last_distance_km = None
        self.coord_widgets["lat1"]["order"][0].focus_set()

    def build_coord_widgets(self, key, fmt):
        is_lat = self.field_meta[key]
        container = self.coord_containers[key]
        for child in list(container.winfo_children()):
            child.destroy()

        widgets = {"fmt": fmt}
        order = []

        if fmt == "dd":
            entry = ttk.Entry(container, width=24)
            entry.pack(side="left")
            widgets["dd"] = entry
            order.append(entry)
        else:
            deg_entry = ttk.Entry(container, width=5)
            deg_entry.pack(side="left")
            ttk.Label(container, text="°").pack(side="left")
            widgets["deg"] = deg_entry
            order.append(deg_entry)

            min_entry = ttk.Entry(container, width=6)
            min_entry.pack(side="left", padx=(4, 0))
            ttk.Label(container, text="'").pack(side="left")
            widgets["min"] = min_entry
            order.append(min_entry)

            if fmt == "dms":
                sec_entry = ttk.Entry(container, width=6)
                sec_entry.pack(side="left", padx=(4, 0))
                ttk.Label(container, text='"').pack(side="left")
                widgets["sec"] = sec_entry
                order.append(sec_entry)

            dir_values = ("N", "S") if is_lat else ("E", "W")
            dir_var = tk.StringVar(value=dir_values[0])
            dir_combo = ttk.Combobox(
                container, width=3, textvariable=dir_var, values=dir_values, state="readonly"
            )
            dir_combo.pack(side="left", padx=(6, 0))
            widgets["dir_var"] = dir_var
            order.append(dir_combo)

        widgets["order"] = order
        self.coord_widgets[key] = widgets

    def rebuild_tab_order(self):
        flat = []
        widget_key = {}
        for key in self.ordered_keys:
            for widget in self.coord_widgets[key]["order"]:
                flat.append(widget)
                widget_key[widget] = key

        for i, widget in enumerate(flat):
            key = widget_key[widget]
            widget.bind("<FocusOut>", lambda event, k=key: self.normalize_coordinate(k))
            if isinstance(widget, ttk.Combobox):
                widget.bind("<<ComboboxSelected>>", lambda event, k=key: self.normalize_coordinate(k))

            if i < len(flat) - 1:
                next_widget = flat[i + 1]

                def handler(event, k=key, nxt=next_widget):
                    self.normalize_coordinate(k)
                    nxt.focus_set()
                    if isinstance(nxt, ttk.Entry):
                        nxt.select_range(0, tk.END)

                widget.bind("<Return>", handler)
            else:
                widget.bind("<Return>", lambda event: self.on_calculate())

    def on_format_change(self):
        new_fmt = self.format_var.get()

        values = {}
        for key in self.ordered_keys:
            try:
                values[key] = self.get_coordinate_value(key)
            except ValueError:
                values[key] = None

        for key in self.ordered_keys:
            self.build_coord_widgets(key, new_fmt)
        self.rebuild_tab_order()

        for key, value in values.items():
            if value is not None:
                self.set_coordinate_value(key, value)

    def get_coordinate_value(self, key):
        is_lat = self.field_meta[key]
        widgets = self.coord_widgets[key]
        fmt = widgets["fmt"]
        axis_name = "Latitude" if is_lat else "Longitude"

        if fmt == "dd":
            text = widgets["dd"].get().strip()
            if not text:
                raise ValueError(f"{axis_name} field is empty.")
            return parse_coordinate(text, is_lat)

        deg_text = widgets["deg"].get().strip()
        min_text = widgets["min"].get().strip()
        has_sec = "sec" in widgets
        sec_text = widgets["sec"].get().strip() if has_sec else ""

        if not deg_text and not min_text and (not has_sec or not sec_text):
            raise ValueError(f"{axis_name} field is empty.")

        if not deg_text or not min_text or (has_sec and not sec_text):
            parts = "degrees/minutes/seconds" if has_sec else "degrees/minutes"
            raise ValueError(f"{axis_name}: please fill in all {parts} fields.")

        try:
            degrees = float(deg_text)
            minutes = float(min_text)
            seconds = float(sec_text) if has_sec else 0.0
        except ValueError:
            raise ValueError(f"{axis_name}: degree/minute/second values must be numeric.")

        if degrees < 0 or minutes < 0 or seconds < 0:
            raise ValueError(f"{axis_name}: use the N/S/E/W selector for sign, not a negative value.")
        if minutes >= 60 or seconds >= 60:
            raise ValueError(f"{axis_name}: minutes/seconds must be less than 60.")

        value = degrees + minutes / 60.0 + seconds / 3600.0
        direction = widgets["dir_var"].get()
        sign = -1.0 if direction in "SW" else 1.0
        value *= sign

        limit = 90 if is_lat else 180
        if not (-limit <= value <= limit):
            raise ValueError(f"{axis_name} must be between -{limit} and {limit} degrees.")

        return value

    def set_coordinate_value(self, key, value):
        widgets = self.coord_widgets[key]
        fmt = widgets["fmt"]

        if fmt == "dd":
            widgets["dd"].delete(0, tk.END)
            widgets["dd"].insert(0, f"{value:.6f}")
            return

        is_lat = self.field_meta[key]
        positive_letter, negative_letter = ("N", "S") if is_lat else ("E", "W")
        direction = positive_letter if value >= 0 else negative_letter

        v = abs(value)
        degrees = int(v)
        minutes_total = (v - degrees) * 60.0

        widgets["deg"].delete(0, tk.END)
        widgets["deg"].insert(0, str(degrees))

        if fmt == "dm":
            widgets["min"].delete(0, tk.END)
            widgets["min"].insert(0, f"{minutes_total:.2f}")
        else:  # dms
            minutes = int(minutes_total)
            seconds = (minutes_total - minutes) * 60.0
            widgets["min"].delete(0, tk.END)
            widgets["min"].insert(0, str(minutes))
            widgets["sec"].delete(0, tk.END)
            widgets["sec"].insert(0, f"{seconds:.2f}")

        widgets["dir_var"].set(direction)

    def normalize_coordinate(self, key, show_errors=False):
        try:
            value = self.get_coordinate_value(key)
        except ValueError as e:
            if show_errors:
                messagebox.showerror("Invalid coordinate", str(e))
            return None

        self.set_coordinate_value(key, value)
        return value

    def on_calculate(self):
        parsed = {}
        for key in self.ordered_keys:
            value = self.normalize_coordinate(key, show_errors=True)
            if value is None:
                return
            parsed[key] = value

        try:
            distance_km = vincenty_distance_km(parsed["lat1"], parsed["lon1"], parsed["lat2"], parsed["lon2"])
        except ValueError as e:
            messagebox.showerror("Calculation error", str(e))
            return

        self.last_distance_km = distance_km
        self.update_result_display()

    def update_result_display(self):
        if self.last_distance_km is None:
            return

        unit = self.unit_var.get()
        if unit == "nm":
            distance = self.last_distance_km / KM_PER_NM
        elif unit == "m":
            distance = self.last_distance_km * 1000
        else:
            distance = self.last_distance_km

        self.result_var.set(f"Distance: {distance:.3f} {unit}")


if __name__ == "__main__":
    root = tk.Tk()
    app = GeoCalculatorApp(root)
    root.mainloop()
